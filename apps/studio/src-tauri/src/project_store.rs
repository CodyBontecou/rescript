use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;

const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_BACKUP: &str = "manifest.json.bak";
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: u64 = 25 * 1024 * 1024;

fn legacy_speaker_diarization_default() -> bool {
    true
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectStoreError {
    #[error("invalid input: {message}")]
    InvalidInput { message: String },
    #[error("project not found: {project_id}")]
    NotFound { project_id: String },
    #[error("project revision conflict (expected {expected}, found {actual})")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("project data is corrupt: {message}")]
    CorruptData { message: String },
    #[error("file operation failed: {message}")]
    FileSystem { message: String },
}

impl From<std::io::Error> for ProjectStoreError {
    fn from(value: std::io::Error) -> Self {
        Self::FileSystem {
            message: value.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelChoice {
    Base,
    Small,
    #[serde(rename = "parakeet-v2")]
    ParakeetV2,
    #[serde(rename = "parakeet-v3")]
    ParakeetV3,
    Import,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub id: u64,
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub speaker: i64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManualCut {
    pub id: u64,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneBoundary {
    pub id: u64,
    pub time: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMediaReference {
    pub relative_path: String,
    pub name: String,
    pub media_type: String,
    pub media_kind: MediaKind,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub media: ProjectMediaReference,
    pub duration: f64,
    pub model: ModelChoice,
    #[serde(default = "legacy_speaker_diarization_default")]
    pub speaker_diarization_enabled: bool,
    pub words: Vec<Word>,
    pub manual_cuts: Vec<ManualCut>,
    pub scene_boundaries: Vec<SceneBoundary>,
    pub show_deleted: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub media_kind: MediaKind,
    pub duration: f64,
    pub model: ModelChoice,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub source_path: String,
    pub name: String,
    pub media_type: String,
    pub media_kind: MediaKind,
    pub duration: Option<f64>,
    pub model: ModelChoice,
    #[serde(default)]
    pub speaker_diarization_enabled: bool,
    #[serde(default)]
    pub words: Vec<Word>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectInput {
    pub project: ProjectManifest,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMediaInfo {
    pub source: String,
    pub name: String,
    pub media_type: String,
    pub media_kind: MediaKind,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTranscript {
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct ProjectStore {
    root: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl ProjectStore {
    pub fn new(root: PathBuf) -> Result<Self, ProjectStoreError> {
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            lock: Arc::new(Mutex::new(())),
        })
    }

    fn acquire(&self) -> Result<MutexGuard<'_, ()>, ProjectStoreError> {
        self.lock.lock().map_err(|_| ProjectStoreError::FileSystem {
            message: "project store lock was poisoned".into(),
        })
    }

    pub fn list(&self) -> Result<Vec<ProjectSummary>, ProjectStoreError> {
        let _guard = self.acquire()?;
        let mut projects = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if validate_project_id(&id).is_err() {
                continue;
            }
            let manifest = self.load_manifest_unlocked(&id)?;
            projects.push(summary_of(&manifest));
        }
        projects.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(projects)
    }

    pub fn read(&self, id: &str) -> Result<Option<ProjectManifest>, ProjectStoreError> {
        validate_project_id(id)?;
        let _guard = self.acquire()?;
        let directory = self.project_directory(id);
        if !directory.exists() {
            return Ok(None);
        }
        Ok(Some(self.load_manifest_unlocked(id)?))
    }

    pub fn create(&self, input: CreateProjectInput) -> Result<ProjectManifest, ProjectStoreError> {
        validate_create_input(&input)?;
        let source = canonical_file(Path::new(&input.source_path))?;
        let metadata = fs::metadata(&source)?;
        let id = Uuid::new_v4().to_string();
        let _guard = self.acquire()?;

        let staging = self.root.join(format!(".{id}.creating"));
        let destination = self.project_directory(&id);
        if staging.exists() {
            fs::remove_dir_all(&staging)?;
        }
        fs::create_dir_all(staging.join("media"))?;

        let result = (|| {
            let extension = safe_extension(&source);
            let media_file = format!("original.{extension}");
            let relative_path = format!("media/{media_file}");
            let destination_media = staging.join(&relative_path);
            copy_file_durable(&source, &destination_media)?;

            let now = now_millis()?;
            let manifest = ProjectManifest {
                schema_version: 1,
                id: id.clone(),
                revision: 0,
                name: input.name,
                media: ProjectMediaReference {
                    relative_path,
                    name: source
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "media".into()),
                    media_type: input.media_type,
                    media_kind: input.media_kind,
                    byte_length: metadata.len(),
                },
                duration: input.duration.unwrap_or(0.0),
                model: input.model,
                speaker_diarization_enabled: input.speaker_diarization_enabled,
                words: input.words,
                manual_cuts: Vec::new(),
                scene_boundaries: Vec::new(),
                show_deleted: false,
                created_at: now,
                updated_at: now,
            };
            validate_manifest(&manifest)?;
            write_json_atomic(&staging.join(MANIFEST_FILE), &manifest)?;
            fs::rename(&staging, &destination)?;
            Ok(manifest)
        })();

        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    pub fn save(&self, input: SaveProjectInput) -> Result<ProjectManifest, ProjectStoreError> {
        validate_manifest(&input.project)?;
        validate_project_id(&input.project.id)?;
        let _guard = self.acquire()?;
        let current = self.load_manifest_unlocked(&input.project.id)?;
        if current.revision != input.expected_revision {
            return Err(ProjectStoreError::RevisionConflict {
                expected: input.expected_revision,
                actual: current.revision,
            });
        }
        if input.project.revision != input.expected_revision {
            return Err(ProjectStoreError::InvalidInput {
                message: "project revision does not match expectedRevision".into(),
            });
        }
        if input.project.media != current.media || input.project.created_at != current.created_at {
            return Err(ProjectStoreError::InvalidInput {
                message: "media reference and createdAt are immutable".into(),
            });
        }

        let mut project = input.project;
        project.schema_version = 1;
        project.revision = input.expected_revision + 1;
        project.updated_at = now_millis()?;
        validate_manifest(&project)?;
        write_json_atomic(
            &self.project_directory(&project.id).join(MANIFEST_FILE),
            &project,
        )?;
        Ok(project)
    }

    pub fn remove(&self, id: &str) -> Result<(), ProjectStoreError> {
        validate_project_id(id)?;
        let _guard = self.acquire()?;
        let directory = self.project_directory(id);
        if !directory.exists() {
            return Ok(());
        }
        let deleting = self.root.join(format!(".{id}.deleting"));
        if deleting.exists() {
            fs::remove_dir_all(&deleting)?;
        }
        fs::rename(&directory, &deleting)?;
        fs::remove_dir_all(deleting)?;
        Ok(())
    }

    pub fn media_path(&self, id: &str) -> Result<String, ProjectStoreError> {
        validate_project_id(id)?;
        let _guard = self.acquire()?;
        let manifest = self.load_manifest_unlocked(id)?;
        let relative = Path::new(&manifest.media.relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(ProjectStoreError::CorruptData {
                message: "project media path is unsafe".into(),
            });
        }
        let project_directory = self.project_directory(id).canonicalize()?;
        let media = project_directory.join(relative).canonicalize()?;
        if !media.starts_with(&project_directory) || !media.is_file() {
            return Err(ProjectStoreError::CorruptData {
                message: "project media is missing or outside project storage".into(),
            });
        }
        Ok(media.to_string_lossy().into_owned())
    }

    pub fn derived_directory(&self, id: &str, revision: u64) -> Result<PathBuf, ProjectStoreError> {
        validate_project_id(id)?;
        let _guard = self.acquire()?;
        let manifest = self.load_manifest_unlocked(id)?;
        if manifest.revision != revision {
            return Err(ProjectStoreError::RevisionConflict {
                expected: revision,
                actual: manifest.revision,
            });
        }
        let directory = self.project_directory(id).join("derived").join("media");
        fs::create_dir_all(&directory)?;
        Ok(directory)
    }

    pub fn prepared_audio_path(
        &self,
        id: &str,
        revision: u64,
    ) -> Result<PathBuf, ProjectStoreError> {
        let audio = self.derived_directory(id, revision)?.join("audio-16k.wav");
        if !audio.is_file() {
            return Err(ProjectStoreError::NotFound {
                project_id: format!("{id} prepared audio"),
            });
        }
        Ok(audio)
    }

    fn project_directory(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    fn load_manifest_unlocked(&self, id: &str) -> Result<ProjectManifest, ProjectStoreError> {
        let directory = self.project_directory(id);
        if !directory.exists() {
            return Err(ProjectStoreError::NotFound {
                project_id: id.into(),
            });
        }
        let path = directory.join(MANIFEST_FILE);
        let backup = directory.join(MANIFEST_BACKUP);
        if !path.exists() && backup.exists() {
            fs::rename(&backup, &path)?;
        }
        let metadata = fs::metadata(&path).map_err(|error| ProjectStoreError::CorruptData {
            message: format!("manifest is missing: {error}"),
        })?;
        if metadata.len() > MAX_MANIFEST_BYTES {
            return Err(ProjectStoreError::CorruptData {
                message: "manifest exceeds the size limit".into(),
            });
        }
        let mut json = String::new();
        File::open(&path)?.read_to_string(&mut json)?;
        let manifest: ProjectManifest =
            serde_json::from_str(&json).map_err(|error| ProjectStoreError::CorruptData {
                message: error.to_string(),
            })?;
        if manifest.id != id {
            return Err(ProjectStoreError::CorruptData {
                message: "manifest id does not match its directory".into(),
            });
        }
        validate_manifest(&manifest)?;
        Ok(manifest)
    }
}

pub fn inspect_media(path: &str) -> Result<ImportedMediaInfo, ProjectStoreError> {
    let source = canonical_file(Path::new(path))?;
    let metadata = fs::metadata(&source)?;
    let media_type = mime_guess::from_path(&source)
        .first_raw()
        .unwrap_or("application/octet-stream")
        .to_string();
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let media_kind = if media_type.starts_with("audio/")
        || matches!(
            extension.as_str(),
            "mp3" | "m4a" | "wav" | "aac" | "flac" | "ogg"
        ) {
        MediaKind::Audio
    } else if media_type.starts_with("video/")
        || matches!(
            extension.as_str(),
            "mp4" | "mov" | "m4v" | "webm" | "mkv" | "avi"
        )
    {
        MediaKind::Video
    } else {
        return Err(ProjectStoreError::InvalidInput {
            message: "selected file is not recognized as audio or video".into(),
        });
    };
    Ok(ImportedMediaInfo {
        source: source.to_string_lossy().into_owned(),
        name: source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "media".into()),
        media_type,
        media_kind,
        byte_length: metadata.len(),
    })
}

pub fn read_transcript(path: &str) -> Result<ImportedTranscript, ProjectStoreError> {
    let source = canonical_file(Path::new(path))?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "srt" | "vtt" | "json") {
        return Err(ProjectStoreError::InvalidInput {
            message: "transcript must be SRT, VTT, or JSON".into(),
        });
    }
    if fs::metadata(&source)?.len() > MAX_TRANSCRIPT_BYTES {
        return Err(ProjectStoreError::InvalidInput {
            message: "transcript exceeds the 25 MB size limit".into(),
        });
    }
    let text = fs::read_to_string(&source).map_err(|error| ProjectStoreError::InvalidInput {
        message: format!("transcript is not valid UTF-8: {error}"),
    })?;
    Ok(ImportedTranscript {
        name: source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "transcript".into()),
        text,
    })
}

fn canonical_file(path: &Path) -> Result<PathBuf, ProjectStoreError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| ProjectStoreError::InvalidInput {
            message: format!("selected file is unavailable: {error}"),
        })?;
    if !canonical.is_file() {
        return Err(ProjectStoreError::InvalidInput {
            message: "selected path is not a file".into(),
        });
    }
    Ok(canonical)
}

fn validate_project_id(id: &str) -> Result<(), ProjectStoreError> {
    Uuid::parse_str(id).map_err(|_| ProjectStoreError::InvalidInput {
        message: "project id must be a UUID".into(),
    })?;
    Ok(())
}

fn validate_create_input(input: &CreateProjectInput) -> Result<(), ProjectStoreError> {
    if input.name.trim().is_empty() {
        return Err(ProjectStoreError::InvalidInput {
            message: "project name cannot be empty".into(),
        });
    }
    if input.media_type.trim().is_empty() {
        return Err(ProjectStoreError::InvalidInput {
            message: "media type cannot be empty".into(),
        });
    }
    let duration = input.duration.unwrap_or(0.0);
    if !duration.is_finite() || duration < 0.0 {
        return Err(ProjectStoreError::InvalidInput {
            message: "duration must be finite and non-negative".into(),
        });
    }
    Ok(())
}

fn validate_manifest(manifest: &ProjectManifest) -> Result<(), ProjectStoreError> {
    if manifest.schema_version != 1 {
        return Err(ProjectStoreError::CorruptData {
            message: format!("unsupported schema version {}", manifest.schema_version),
        });
    }
    validate_project_id(&manifest.id)?;
    if manifest.name.trim().is_empty() || manifest.media.name.trim().is_empty() {
        return Err(ProjectStoreError::InvalidInput {
            message: "project and media names cannot be empty".into(),
        });
    }
    if !manifest.duration.is_finite() || manifest.duration < 0.0 {
        return Err(ProjectStoreError::InvalidInput {
            message: "duration must be finite and non-negative".into(),
        });
    }
    let valid_range = |start: f64, end: f64| {
        start.is_finite()
            && end.is_finite()
            && start >= 0.0
            && end > start
            && end <= manifest.duration + 0.0001
    };
    let word_ids = manifest
        .words
        .iter()
        .map(|word| word.id)
        .collect::<HashSet<_>>();
    if manifest
        .words
        .iter()
        .any(|word| !valid_range(word.start, word.end) || word.speaker < 0)
        || manifest
            .words
            .windows(2)
            .any(|pair| pair[0].start > pair[1].start)
        || word_ids.len() != manifest.words.len()
    {
        return Err(ProjectStoreError::InvalidInput {
            message: "word timings and IDs must be ordered, unique, and within duration".into(),
        });
    }
    let cut_ids = manifest
        .manual_cuts
        .iter()
        .map(|cut| cut.id)
        .collect::<HashSet<_>>();
    if manifest
        .manual_cuts
        .iter()
        .any(|cut| !valid_range(cut.start, cut.end))
        || cut_ids.len() != manifest.manual_cuts.len()
    {
        return Err(ProjectStoreError::InvalidInput {
            message: "manual cuts must have unique IDs and stay within duration".into(),
        });
    }
    let boundary_ids = manifest
        .scene_boundaries
        .iter()
        .map(|boundary| boundary.id)
        .collect::<HashSet<_>>();
    if manifest.scene_boundaries.iter().any(|boundary| {
        !boundary.time.is_finite() || boundary.time <= 0.0 || boundary.time >= manifest.duration
    }) || manifest
        .scene_boundaries
        .windows(2)
        .any(|pair| pair[0].time >= pair[1].time)
        || boundary_ids.len() != manifest.scene_boundaries.len()
    {
        return Err(ProjectStoreError::InvalidInput {
            message: "scene boundaries must be inside duration".into(),
        });
    }
    let relative = Path::new(&manifest.media.relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !manifest.media.relative_path.starts_with("media/")
    {
        return Err(ProjectStoreError::InvalidInput {
            message: "media relativePath is unsafe".into(),
        });
    }
    Ok(())
}

fn safe_extension(source: &Path) -> String {
    source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| {
            value
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .take(12)
                .collect::<String>()
                .to_ascii_lowercase()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "bin".into())
}

fn copy_file_durable(source: &Path, destination: &Path) -> Result<(), ProjectStoreError> {
    let mut input = File::open(source)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    std::io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    Ok(())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), ProjectStoreError> {
    let parent = path.parent().ok_or_else(|| ProjectStoreError::FileSystem {
        message: "manifest has no parent directory".into(),
    })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{MANIFEST_FILE}.{}.tmp", Uuid::new_v4()));
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| ProjectStoreError::FileSystem {
            message: error.to_string(),
        })?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);

    if !path.exists() {
        fs::rename(&temporary, path)?;
        return Ok(());
    }

    let backup = parent.join(MANIFEST_BACKUP);
    if backup.exists() {
        fs::remove_file(&backup)?;
    }
    fs::rename(path, &backup)?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::rename(&backup, path);
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    fs::remove_file(backup)?;
    Ok(())
}

fn summary_of(manifest: &ProjectManifest) -> ProjectSummary {
    ProjectSummary {
        id: manifest.id.clone(),
        revision: manifest.revision,
        name: manifest.name.clone(),
        media_kind: manifest.media.media_kind,
        duration: manifest.duration,
        model: manifest.model,
        created_at: manifest.created_at,
        updated_at: manifest.updated_at,
    }
}

fn now_millis() -> Result<u64, ProjectStoreError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| ProjectStoreError::FileSystem {
            message: error.to_string(),
        })?;
    Ok(duration.as_millis().try_into().unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_input(source: &Path) -> CreateProjectInput {
        CreateProjectInput {
            source_path: source.to_string_lossy().into_owned(),
            name: "Sample.mov".into(),
            media_type: "video/quicktime".into(),
            media_kind: MediaKind::Video,
            duration: Some(4.0),
            model: ModelChoice::Base,
            speaker_diarization_enabled: false,
            words: vec![Word {
                id: 0,
                text: "hello".into(),
                start: 0.0,
                end: 0.5,
                speaker: 0,
                deleted: false,
            }],
        }
    }

    #[test]
    fn serializes_parakeet_model_ids_with_hyphens() {
        assert_eq!(
            serde_json::to_string(&ModelChoice::ParakeetV2).unwrap(),
            "\"parakeet-v2\""
        );
        assert_eq!(
            serde_json::to_string(&ModelChoice::ParakeetV3).unwrap(),
            "\"parakeet-v3\""
        );
    }

    #[test]
    fn legacy_manifests_keep_speaker_diarization_enabled() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("sample.mov");
        fs::write(&source, b"media").unwrap();
        let store = ProjectStore::new(directory.path().join("projects")).unwrap();
        let created = store.create(create_input(&source)).unwrap();
        let mut value = serde_json::to_value(created).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("speakerDiarizationEnabled");
        let decoded: ProjectManifest = serde_json::from_value(value).unwrap();
        assert!(decoded.speaker_diarization_enabled);
    }

    #[test]
    fn creates_reads_saves_lists_and_removes_projects() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("sample.mov");
        fs::write(&source, b"fake movie bytes").unwrap();
        let store = ProjectStore::new(directory.path().join("projects")).unwrap();

        let created = store.create(create_input(&source)).unwrap();
        assert_eq!(created.revision, 0);
        assert!(!created.speaker_diarization_enabled);
        assert!(Path::new(&store.media_path(&created.id).unwrap()).exists());
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.read(&created.id).unwrap().unwrap(), created);

        let mut changed = created.clone();
        changed.name = "Renamed".into();
        let saved = store
            .save(SaveProjectInput {
                project: changed,
                expected_revision: 0,
            })
            .unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.name, "Renamed");

        let conflict = store.save(SaveProjectInput {
            project: created.clone(),
            expected_revision: 0,
        });
        assert!(matches!(
            conflict,
            Err(ProjectStoreError::RevisionConflict { actual: 1, .. })
        ));

        store.remove(&created.id).unwrap();
        assert!(store.read(&created.id).unwrap().is_none());
    }

    #[test]
    fn rejects_paths_and_timings_outside_project_boundaries() {
        assert!(validate_project_id("../escape").is_err());
        let directory = tempdir().unwrap();
        let source = directory.path().join("sample.mov");
        fs::write(&source, b"media").unwrap();
        let store = ProjectStore::new(directory.path().join("projects")).unwrap();
        let mut created = store.create(create_input(&source)).unwrap();
        created.words[0].end = 8.0;
        assert!(store
            .save(SaveProjectInput {
                project: created,
                expected_revision: 0,
            })
            .is_err());
    }

    #[test]
    fn rejects_unordered_or_duplicate_transcript_words() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("sample.mov");
        fs::write(&source, b"media").unwrap();
        let store = ProjectStore::new(directory.path().join("projects")).unwrap();
        let created = store.create(create_input(&source)).unwrap();

        let mut unordered = created.clone();
        unordered.words[0].start = 0.4;
        unordered.words.push(Word {
            id: 1,
            text: "earlier".into(),
            start: 0.1,
            end: 0.2,
            speaker: 0,
            deleted: false,
        });
        assert!(store
            .save(SaveProjectInput {
                project: unordered,
                expected_revision: 0,
            })
            .is_err());

        let mut duplicate = created;
        duplicate.words.push(Word {
            id: 0,
            text: "duplicate".into(),
            start: 0.6,
            end: 0.8,
            speaker: 0,
            deleted: false,
        });
        assert!(store
            .save(SaveProjectInput {
                project: duplicate,
                expected_revision: 0,
            })
            .is_err());
    }

    #[test]
    fn transcript_reads_are_utf8_and_extension_limited() {
        let directory = tempdir().unwrap();
        let transcript = directory.path().join("sample.srt");
        fs::write(&transcript, "hello").unwrap();
        assert_eq!(
            read_transcript(&transcript.to_string_lossy()).unwrap().text,
            "hello"
        );
        let text = directory.path().join("sample.txt");
        fs::write(&text, "hello").unwrap();
        assert!(read_transcript(&text.to_string_lossy()).is_err());
    }
}
