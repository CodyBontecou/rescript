#![cfg_attr(target_os = "ios", allow(dead_code))]

use crate::project_store::{MediaKind, ProjectStore, ProjectStoreError};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use uuid::Uuid;

pub const JOB_PROGRESS_EVENT: &str = "rescript://job-progress";

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MediaJobError {
    #[error("invalid media job: {message}")]
    InvalidInput { message: String },
    #[error("media job not found: {job_id}")]
    NotFound { job_id: String },
    #[error("native media tool is unavailable: {message}")]
    ToolUnavailable { message: String },
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    #[error("unlimited exports purchase required")]
    PurchaseRequired,
    #[error("media job failed: {message}")]
    Failed { message: String },
    #[error("media job was cancelled")]
    Cancelled,
}

impl From<ProjectStoreError> for MediaJobError {
    fn from(value: ProjectStoreError) -> Self {
        Self::InvalidInput {
            message: value.to_string(),
        }
    }
}

impl From<std::io::Error> for MediaJobError {
    fn from(value: std::io::Error) -> Self {
        Self::Failed {
            message: value.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Media,
    Transcription,
    Export,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub job_id: String,
    pub kind: JobKind,
    pub status: JobStatus,
    pub phase: String,
    pub message: String,
    pub ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMedia {
    pub duration: f64,
    pub sample_rate: u32,
    pub waveform_samples_per_second: f64,
    pub waveform: Vec<f64>,
    pub audio_reference: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaExportResult {
    pub destination: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
enum JobResult {
    PreparedMedia(PreparedMedia),
    MediaExport(MediaExportResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobJournal {
    progress: JobProgress,
    result: Option<JobResult>,
}

struct JobRecord {
    journal: Mutex<JobJournal>,
    cancel: AtomicBool,
}

impl JobRecord {
    fn new(progress: JobProgress) -> Self {
        Self {
            journal: Mutex::new(JobJournal {
                progress,
                result: None,
            }),
            cancel: AtomicBool::new(false),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareMediaRequest {
    pub project_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDestination {
    pub destination: String,
    #[allow(dead_code)]
    pub display_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMediaRequest {
    pub project_id: String,
    pub revision: u64,
    pub keep_ranges: Vec<TimeRange>,
    pub destination: ExportDestination,
}

#[derive(Clone)]
pub struct MediaJobManager {
    root: PathBuf,
    records: Arc<Mutex<HashMap<String, Arc<JobRecord>>>>,
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

impl MediaJobManager {
    pub fn new(root: PathBuf, resource_dir: PathBuf) -> Result<Self, MediaJobError> {
        fs::create_dir_all(&root)?;
        let manager = Self {
            root,
            records: Arc::new(Mutex::new(HashMap::new())),
            ffmpeg: media_tool(&resource_dir, "ffmpeg"),
            ffprobe: media_tool(&resource_dir, "ffprobe"),
        };
        manager.restore_journals()?;
        Ok(manager)
    }

    pub fn start_prepare(
        &self,
        app: AppHandle,
        projects: ProjectStore,
        request: PrepareMediaRequest,
    ) -> Result<String, MediaJobError> {
        let manifest =
            projects
                .read(&request.project_id)?
                .ok_or_else(|| MediaJobError::InvalidInput {
                    message: "project does not exist".into(),
                })?;
        if manifest.revision != request.revision {
            return Err(MediaJobError::InvalidInput {
                message: format!(
                    "project revision changed (requested {}, found {})",
                    request.revision, manifest.revision
                ),
            });
        }

        let (job_id, record) = self.create_job(JobKind::Media)?;
        let manager = self.clone();
        let request_for_thread = request.clone();
        thread::spawn(move || {
            manager.update(
                Some(&app),
                &record,
                JobStatus::Running,
                "decode",
                "Preparing native audio",
                Some(0.01),
            );
            match manager.run_prepare(Some(&app), &record, &projects, &request_for_thread) {
                Ok(result) => manager.complete(&app, &record, JobResult::PreparedMedia(result)),
                Err(MediaJobError::Cancelled) => manager.update(
                    Some(&app),
                    &record,
                    JobStatus::Cancelled,
                    "cancelled",
                    "Media preparation cancelled",
                    None,
                ),
                Err(error) => manager.update(
                    Some(&app),
                    &record,
                    JobStatus::Failed,
                    "failed",
                    &error.to_string(),
                    None,
                ),
            }
        });
        Ok(job_id)
    }

    pub fn start_export(
        &self,
        app: AppHandle,
        projects: ProjectStore,
        request: ExportMediaRequest,
    ) -> Result<String, MediaJobError> {
        validate_keep_ranges(&request.keep_ranges)?;
        let manifest =
            projects
                .read(&request.project_id)?
                .ok_or_else(|| MediaJobError::InvalidInput {
                    message: "project does not exist".into(),
                })?;
        if manifest.revision != request.revision {
            return Err(MediaJobError::InvalidInput {
                message: format!(
                    "project revision changed (requested {}, found {})",
                    request.revision, manifest.revision
                ),
            });
        }
        if request
            .keep_ranges
            .iter()
            .any(|range| range.end > manifest.duration + 0.0001)
        {
            return Err(MediaJobError::InvalidInput {
                message: "export range exceeds project duration".into(),
            });
        }

        let (job_id, record) = self.create_job(JobKind::Export)?;
        let manager = self.clone();
        thread::spawn(move || {
            manager.update(
                Some(&app),
                &record,
                JobStatus::Running,
                "export",
                "Rendering edited media",
                Some(0.01),
            );
            match manager.run_export(
                Some(&app),
                &record,
                &projects,
                &request,
                manifest.media.media_kind,
            ) {
                Ok(result) => manager.complete(&app, &record, JobResult::MediaExport(result)),
                Err(MediaJobError::Cancelled) => manager.update(
                    Some(&app),
                    &record,
                    JobStatus::Cancelled,
                    "cancelled",
                    "Export cancelled",
                    None,
                ),
                Err(error) => manager.update(
                    Some(&app),
                    &record,
                    JobStatus::Failed,
                    "failed",
                    &error.to_string(),
                    None,
                ),
            }
        });
        Ok(job_id)
    }

    pub fn snapshot(&self, job_id: &str) -> Result<Option<JobProgress>, MediaJobError> {
        let record = self.record(job_id)?;
        let progress = record
            .journal
            .lock()
            .map_err(|_| lock_error())?
            .progress
            .clone();
        Ok(Some(progress))
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), MediaJobError> {
        self.record(job_id)?.cancel.store(true, Ordering::Release);
        Ok(())
    }

    pub fn prepare_result(&self, job_id: &str) -> Result<Option<PreparedMedia>, MediaJobError> {
        let record = self.record(job_id)?;
        let journal = record.journal.lock().map_err(|_| lock_error())?;
        Ok(match &journal.result {
            Some(JobResult::PreparedMedia(result)) => Some(result.clone()),
            _ => None,
        })
    }

    pub fn export_result(&self, job_id: &str) -> Result<Option<MediaExportResult>, MediaJobError> {
        let record = self.record(job_id)?;
        let journal = record.journal.lock().map_err(|_| lock_error())?;
        Ok(match &journal.result {
            Some(JobResult::MediaExport(result)) => Some(result.clone()),
            _ => None,
        })
    }

    fn run_prepare(
        &self,
        app: Option<&AppHandle>,
        record: &Arc<JobRecord>,
        projects: &ProjectStore,
        request: &PrepareMediaRequest,
    ) -> Result<PreparedMedia, MediaJobError> {
        ensure_tool(&self.ffmpeg, "ffmpeg")?;
        ensure_tool(&self.ffprobe, "ffprobe")?;
        let input = PathBuf::from(projects.media_path(&request.project_id)?);
        let derived = projects.derived_directory(&request.project_id, request.revision)?;
        let audio = derived.join("audio-16k.wav");
        let waveform_json = derived.join("waveform.json");

        if audio.exists() && waveform_json.exists() {
            let mut result: PreparedMedia = serde_json::from_slice(&fs::read(&waveform_json)?)
                .map_err(|error| MediaJobError::Failed {
                    message: format!("cached waveform is invalid: {error}"),
                })?;
            result.audio_reference = format!(
                "project:{}:revision:{}:audio-16k.wav",
                request.project_id, request.revision
            );
            return Ok(result);
        }

        let duration = probe_duration(&self.ffprobe, &input)?;
        let temporary_audio = derived.join(".audio-16k.tmp.wav");
        let progress = derived.join(".prepare-progress.txt");
        let error_log = derived.join(".prepare-error.txt");
        remove_if_exists(&temporary_audio)?;
        remove_if_exists(&progress)?;
        remove_if_exists(&error_log)?;

        let arguments = vec![
            "-y".into(),
            "-i".into(),
            input.to_string_lossy().into_owned(),
            "-vn".into(),
            "-ac".into(),
            "1".into(),
            "-ar".into(),
            "16000".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            "-f".into(),
            "wav".into(),
            "-progress".into(),
            progress.to_string_lossy().into_owned(),
            "-nostats".into(),
            temporary_audio.to_string_lossy().into_owned(),
        ];
        self.run_ffmpeg(
            app,
            record,
            &arguments,
            &progress,
            &error_log,
            duration,
            (0.02, 0.78),
            "decode",
            "Decoding audio",
        )?;
        fs::rename(&temporary_audio, &audio)?;

        self.update(
            app,
            record,
            JobStatus::Running,
            "waveform",
            "Building waveform",
            Some(0.82),
        );
        let waveform = waveform_from_wav(&audio, record)?;
        let result = PreparedMedia {
            duration,
            sample_rate: 16_000,
            waveform_samples_per_second: 100.0,
            waveform,
            audio_reference: format!(
                "project:{}:revision:{}:audio-16k.wav",
                request.project_id, request.revision
            ),
        };
        write_json_replace(&waveform_json, &result)?;
        remove_if_exists(&progress)?;
        remove_if_exists(&error_log)?;
        Ok(result)
    }

    fn run_export(
        &self,
        app: Option<&AppHandle>,
        record: &Arc<JobRecord>,
        projects: &ProjectStore,
        request: &ExportMediaRequest,
        media_kind: MediaKind,
    ) -> Result<MediaExportResult, MediaJobError> {
        ensure_tool(&self.ffmpeg, "ffmpeg")?;
        ensure_tool(&self.ffprobe, "ffprobe")?;
        let input = PathBuf::from(projects.media_path(&request.project_id)?);
        let destination = export_destination(&request.destination.destination, media_kind)?;
        let parent = destination
            .parent()
            .ok_or_else(|| MediaJobError::InvalidInput {
                message: "export destination has no parent".into(),
            })?;
        fs::create_dir_all(parent)?;
        let extension = destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or(if media_kind == MediaKind::Audio {
                "m4a"
            } else {
                "mp4"
            });
        let temporary = parent.join(format!(
            ".{}.{}.tmp.{extension}",
            destination
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("export"),
            Uuid::new_v4()
        ));
        let progress = parent.join(format!(".rescript-{}.progress", Uuid::new_v4()));
        let error_log = parent.join(format!(".rescript-{}.error", Uuid::new_v4()));
        let output_duration: f64 = request
            .keep_ranges
            .iter()
            .map(|range| range.end - range.start)
            .sum();
        let has_audio = media_kind == MediaKind::Audio || probe_has_audio(&self.ffprobe, &input)?;
        let (filter, video_map, audio_map) =
            export_filter(&request.keep_ranges, media_kind, has_audio);

        let mut arguments = vec![
            "-y".into(),
            "-i".into(),
            input.to_string_lossy().into_owned(),
            "-filter_complex".into(),
            filter,
        ];
        if let Some(map) = video_map {
            arguments.extend(["-map".into(), map]);
        }
        if let Some(map) = audio_map {
            arguments.extend(["-map".into(), map]);
        }
        if media_kind == MediaKind::Video {
            #[cfg(target_os = "macos")]
            arguments.extend([
                "-c:v".into(),
                "h264_videotoolbox".into(),
                "-b:v".into(),
                "8M".into(),
            ]);
            #[cfg(not(target_os = "macos"))]
            arguments.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "medium".into(),
            ]);
            if has_audio {
                arguments.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
            }
            arguments.extend([
                "-movflags".into(),
                "+faststart".into(),
                "-f".into(),
                "mp4".into(),
            ]);
        } else if extension.eq_ignore_ascii_case("wav") {
            arguments.extend(["-c:a".into(), "pcm_s16le".into(), "-f".into(), "wav".into()]);
        } else {
            arguments.extend([
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
                "-f".into(),
                "ipod".into(),
            ]);
        }
        arguments.extend([
            "-progress".into(),
            progress.to_string_lossy().into_owned(),
            "-nostats".into(),
            temporary.to_string_lossy().into_owned(),
        ]);

        let run_result = self.run_ffmpeg(
            app,
            record,
            &arguments,
            &progress,
            &error_log,
            output_duration,
            (0.02, 0.97),
            "export",
            "Rendering edited media",
        );
        if let Err(error) = run_result {
            let _ = remove_if_exists(&temporary);
            let _ = remove_if_exists(&progress);
            return Err(error);
        }
        replace_file(&temporary, &destination)?;
        let byte_length = fs::metadata(&destination)?.len();
        remove_if_exists(&progress)?;
        remove_if_exists(&error_log)?;
        Ok(MediaExportResult {
            destination: destination.to_string_lossy().into_owned(),
            byte_length,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn run_ffmpeg(
        &self,
        app: Option<&AppHandle>,
        record: &Arc<JobRecord>,
        arguments: &[String],
        progress_path: &Path,
        error_path: &Path,
        duration: f64,
        ratio_range: (f64, f64),
        phase: &str,
        message: &str,
    ) -> Result<(), MediaJobError> {
        let stderr = File::create(error_path)?;
        let mut child = Command::new(&self.ffmpeg)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr))
            .spawn()
            .map_err(|error| MediaJobError::ToolUnavailable {
                message: format!("cannot launch ffmpeg: {error}"),
            })?;
        let mut last_ratio = ratio_range.0;
        loop {
            if record.cancel.load(Ordering::Acquire) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(MediaJobError::Cancelled);
            }
            if let Some(status) = child.try_wait()? {
                if status.success() {
                    return Ok(());
                }
                return Err(MediaJobError::Failed {
                    message: tail_file(error_path, 8_000)
                        .unwrap_or_else(|| format!("ffmpeg exited with {status}")),
                });
            }
            if let Some(seconds) = read_progress_seconds(progress_path) {
                let fraction = if duration > 0.0 {
                    (seconds / duration).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let ratio = ratio_range.0 + fraction * (ratio_range.1 - ratio_range.0);
                if ratio >= last_ratio + 0.005 {
                    last_ratio = ratio;
                    self.update(app, record, JobStatus::Running, phase, message, Some(ratio));
                }
            }
            thread::sleep(Duration::from_millis(150));
        }
    }

    fn create_job(&self, kind: JobKind) -> Result<(String, Arc<JobRecord>), MediaJobError> {
        let job_id = Uuid::new_v4().to_string();
        let record = Arc::new(JobRecord::new(JobProgress {
            job_id: job_id.clone(),
            kind,
            status: JobStatus::Queued,
            phase: "queued".into(),
            message: "Queued".into(),
            ratio: Some(0.0),
        }));
        self.records
            .lock()
            .map_err(|_| lock_error())?
            .insert(job_id.clone(), record.clone());
        self.persist(&record);
        Ok((job_id, record))
    }

    fn record(&self, job_id: &str) -> Result<Arc<JobRecord>, MediaJobError> {
        self.records
            .lock()
            .map_err(|_| lock_error())?
            .get(job_id)
            .cloned()
            .ok_or_else(|| MediaJobError::NotFound {
                job_id: job_id.into(),
            })
    }

    fn update(
        &self,
        app: Option<&AppHandle>,
        record: &Arc<JobRecord>,
        status: JobStatus,
        phase: &str,
        message: &str,
        ratio: Option<f64>,
    ) {
        if let Ok(mut journal) = record.journal.lock() {
            journal.progress.status = status;
            journal.progress.phase = phase.into();
            journal.progress.message = message.into();
            journal.progress.ratio = ratio.map(|value| value.clamp(0.0, 1.0));
            let progress = journal.progress.clone();
            drop(journal);
            self.persist(record);
            if let Some(app) = app {
                let _ = app.emit(JOB_PROGRESS_EVENT, progress);
            }
        }
    }

    fn complete(&self, app: &AppHandle, record: &Arc<JobRecord>, result: JobResult) {
        if let Ok(mut journal) = record.journal.lock() {
            journal.result = Some(result);
            journal.progress.status = JobStatus::Completed;
            journal.progress.phase = "completed".into();
            journal.progress.message = "Completed".into();
            journal.progress.ratio = Some(1.0);
            let progress = journal.progress.clone();
            drop(journal);
            self.persist(record);
            let _ = app.emit(JOB_PROGRESS_EVENT, progress);
        }
    }

    fn persist(&self, record: &Arc<JobRecord>) {
        let Ok(journal) = record.journal.lock() else {
            return;
        };
        let path = self.root.join(format!("{}.json", journal.progress.job_id));
        let _ = write_json_replace(&path, &*journal);
    }

    fn restore_journals(&self) -> Result<(), MediaJobError> {
        let mut records = self.records.lock().map_err(|_| lock_error())?;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(mut journal) = serde_json::from_slice::<JobJournal>(&bytes) else {
                continue;
            };
            if matches!(
                journal.progress.status,
                JobStatus::Queued | JobStatus::Running
            ) {
                journal.progress.status = JobStatus::Failed;
                journal.progress.phase = "interrupted".into();
                journal.progress.message = "Job was interrupted by application restart".into();
                journal.progress.ratio = None;
                let _ = write_json_replace(&entry.path(), &journal);
            }
            records.insert(
                journal.progress.job_id.clone(),
                Arc::new(JobRecord {
                    journal: Mutex::new(journal),
                    cancel: AtomicBool::new(false),
                }),
            );
        }
        Ok(())
    }
}

fn media_tool(resource_dir: &Path, name: &str) -> PathBuf {
    let environment_key = format!("RESCRIPT_{}", name.to_ascii_uppercase());
    if let Ok(path) = std::env::var(environment_key) {
        return PathBuf::from(path);
    }
    let bundled = resource_dir.join("bin").join(name);
    if bundled.exists() {
        return bundled;
    }
    #[cfg(target_os = "macos")]
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let candidate = Path::new(prefix).join(name);
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(name)
}

fn ensure_tool(path: &Path, name: &str) -> Result<(), MediaJobError> {
    Command::new(path)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| MediaJobError::ToolUnavailable {
            message: format!(
                "{name} is required. Bundle it in resources/bin or set RESCRIPT_{} ({error})",
                name.to_ascii_uppercase()
            ),
        })?;
    Ok(())
}

fn probe_duration(ffprobe: &Path, input: &Path) -> Result<f64, MediaJobError> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(input)
        .output()
        .map_err(|error| MediaJobError::ToolUnavailable {
            message: format!("cannot launch ffprobe: {error}"),
        })?;
    if !output.status.success() {
        return Err(MediaJobError::Failed {
            message: String::from_utf8_lossy(&output.stderr).trim().into(),
        });
    }
    let duration = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|_| MediaJobError::Failed {
            message: "ffprobe did not return a valid duration".into(),
        })?;
    if !duration.is_finite() || duration <= 0.0 {
        return Err(MediaJobError::Failed {
            message: "media duration is unavailable".into(),
        });
    }
    Ok(duration)
}

fn probe_has_audio(ffprobe: &Path, input: &Path) -> Result<bool, MediaJobError> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
        ])
        .arg(input)
        .output()?;
    Ok(output.status.success() && !output.stdout.is_empty())
}

fn waveform_from_wav(path: &Path, record: &Arc<JobRecord>) -> Result<Vec<f64>, MediaJobError> {
    let mut reader = hound::WavReader::open(path).map_err(|error| MediaJobError::Failed {
        message: format!("cannot read prepared audio: {error}"),
    })?;
    let specification = reader.spec();
    if specification.channels != 1 || specification.sample_rate != 16_000 {
        return Err(MediaJobError::Failed {
            message: "prepared audio has an unexpected format".into(),
        });
    }
    let bucket_size = (specification.sample_rate / 100).max(1) as usize;
    let mut waveform = Vec::new();
    let mut peak = 0.0_f64;
    let mut count = 0_usize;
    for sample in reader.samples::<i16>() {
        if record.cancel.load(Ordering::Acquire) {
            return Err(MediaJobError::Cancelled);
        }
        let sample = sample.map_err(|error| MediaJobError::Failed {
            message: format!("cannot decode prepared waveform: {error}"),
        })?;
        peak = peak.max((sample as f64 / i16::MAX as f64).abs().min(1.0));
        count += 1;
        if count == bucket_size {
            waveform.push(peak);
            peak = 0.0;
            count = 0;
        }
    }
    if count > 0 {
        waveform.push(peak);
    }
    Ok(waveform)
}

fn validate_keep_ranges(ranges: &[TimeRange]) -> Result<(), MediaJobError> {
    if ranges.is_empty() {
        return Err(MediaJobError::InvalidInput {
            message: "export needs at least one keep range".into(),
        });
    }
    let mut previous_end = 0.0;
    for range in ranges {
        if !range.start.is_finite()
            || !range.end.is_finite()
            || range.start < previous_end
            || range.end <= range.start
        {
            return Err(MediaJobError::InvalidInput {
                message: "export ranges must be finite, ordered, and non-overlapping".into(),
            });
        }
        previous_end = range.end;
    }
    Ok(())
}

fn export_filter(
    ranges: &[TimeRange],
    media_kind: MediaKind,
    has_audio: bool,
) -> (String, Option<String>, Option<String>) {
    let mut parts = Vec::new();
    for (index, range) in ranges.iter().enumerate() {
        if media_kind == MediaKind::Video {
            parts.push(format!(
                "[0:v]trim=start={:.6}:end={:.6},setpts=PTS-STARTPTS[v{index}]",
                range.start, range.end
            ));
        }
        if has_audio {
            parts.push(format!(
                "[0:a]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS[a{index}]",
                range.start, range.end
            ));
        }
    }
    let mut inputs = String::new();
    for index in 0..ranges.len() {
        if media_kind == MediaKind::Video {
            inputs.push_str(&format!("[v{index}]"));
        }
        if has_audio {
            inputs.push_str(&format!("[a{index}]"));
        }
    }
    if media_kind == MediaKind::Video {
        if has_audio {
            parts.push(format!(
                "{inputs}concat=n={}:v=1:a=1[outv][outa]",
                ranges.len()
            ));
            (
                parts.join(";"),
                Some("[outv]".into()),
                Some("[outa]".into()),
            )
        } else {
            parts.push(format!("{inputs}concat=n={}:v=1:a=0[outv]", ranges.len()));
            (parts.join(";"), Some("[outv]".into()), None)
        }
    } else {
        parts.push(format!("{inputs}concat=n={}:v=0:a=1[outa]", ranges.len()));
        (parts.join(";"), None, Some("[outa]".into()))
    }
}

fn export_destination(path: &str, media_kind: MediaKind) -> Result<PathBuf, MediaJobError> {
    let destination = PathBuf::from(path);
    if !destination.is_absolute() {
        return Err(MediaJobError::InvalidInput {
            message: "export destination must be absolute".into(),
        });
    }
    let extension = destination
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let valid = match media_kind {
        MediaKind::Video => matches!(extension.as_str(), "mp4" | "mov"),
        MediaKind::Audio => matches!(extension.as_str(), "m4a" | "wav"),
    };
    if !valid {
        return Err(MediaJobError::InvalidInput {
            message: "export extension does not match the project media kind".into(),
        });
    }
    Ok(destination)
}

fn read_progress_seconds(path: &Path) -> Option<f64> {
    let text = fs::read_to_string(path).ok()?;
    text.lines().rev().find_map(|line| {
        line.strip_prefix("out_time_us=")
            .and_then(|value| value.parse::<f64>().ok())
            .map(|microseconds| microseconds / 1_000_000.0)
    })
}

fn tail_file(path: &Path, maximum: usize) -> Option<String> {
    let mut bytes = Vec::new();
    File::open(path).ok()?.read_to_end(&mut bytes).ok()?;
    let from = bytes.len().saturating_sub(maximum);
    Some(String::from_utf8_lossy(&bytes[from..]).trim().into())
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), MediaJobError> {
    let backup = destination.with_file_name(format!(
        ".{}.rescript-backup",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("export")
    ));
    if backup.exists() {
        fs::remove_file(&backup)?;
    }
    if destination.exists() {
        fs::rename(destination, &backup)?;
    }
    if let Err(error) = fs::rename(source, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        return Err(error.into());
    }
    remove_if_exists(&backup)?;
    Ok(())
}

fn write_json_replace<T: Serialize>(path: &Path, value: &T) -> Result<(), MediaJobError> {
    let parent = path.parent().ok_or_else(|| MediaJobError::Failed {
        message: "job file has no parent".into(),
    })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec(value).map_err(|error| MediaJobError::Failed {
            message: error.to_string(),
        })?,
    )?;
    replace_file(&temporary, path)
}

fn remove_if_exists(path: &Path) -> Result<(), MediaJobError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn lock_error() -> MediaJobError {
    MediaJobError::Failed {
        message: "media job state lock was poisoned".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ordered_ranges() {
        assert!(validate_keep_ranges(&[
            TimeRange {
                start: 0.0,
                end: 1.0
            },
            TimeRange {
                start: 2.0,
                end: 3.0
            },
        ])
        .is_ok());
        assert!(validate_keep_ranges(&[
            TimeRange {
                start: 1.0,
                end: 2.0
            },
            TimeRange {
                start: 1.5,
                end: 3.0
            },
        ])
        .is_err());
    }

    #[test]
    fn builds_audio_and_video_concat_filters() {
        let ranges = vec![
            TimeRange {
                start: 0.0,
                end: 1.0,
            },
            TimeRange {
                start: 2.0,
                end: 3.0,
            },
        ];
        let (filter, video, audio) = export_filter(&ranges, MediaKind::Video, true);
        assert!(filter.contains("concat=n=2:v=1:a=1"));
        assert_eq!(video.as_deref(), Some("[outv]"));
        assert_eq!(audio.as_deref(), Some("[outa]"));

        let (filter, video, audio) = export_filter(&ranges, MediaKind::Audio, true);
        assert!(filter.contains("concat=n=2:v=0:a=1"));
        assert!(video.is_none());
        assert_eq!(audio.as_deref(), Some("[outa]"));
    }

    #[test]
    fn parses_ffmpeg_progress() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("progress");
        fs::write(&path, "frame=3\nout_time_us=2500000\nprogress=continue\n").unwrap();
        assert_eq!(read_progress_seconds(&path), Some(2.5));
    }

    #[test]
    fn prepares_waveform_and_exports_audio_when_ffmpeg_is_available() {
        use crate::project_store::{CreateProjectInput, ModelChoice};

        if ensure_tool(Path::new("ffmpeg"), "ffmpeg").is_err()
            || ensure_tool(Path::new("ffprobe"), "ffprobe").is_err()
        {
            return;
        }

        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.wav");
        let specification = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&source, specification).unwrap();
        for index in 0..32_000 {
            let sample = ((index as f64 / 20.0).sin() * i16::MAX as f64 * 0.35) as i16;
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();

        let projects = ProjectStore::new(directory.path().join("projects")).unwrap();
        let project = projects
            .create(CreateProjectInput {
                source_path: source.to_string_lossy().into_owned(),
                name: "Source audio".into(),
                media_type: "audio/wav".into(),
                media_kind: MediaKind::Audio,
                duration: Some(2.0),
                model: ModelChoice::Base,
                speaker_diarization_enabled: false,
                words: Vec::new(),
            })
            .unwrap();
        let manager = MediaJobManager::new(
            directory.path().join("jobs"),
            directory.path().join("resources"),
        )
        .unwrap();
        let (_, prepare_record) = manager.create_job(JobKind::Media).unwrap();
        let prepared = manager
            .run_prepare(
                None,
                &prepare_record,
                &projects,
                &PrepareMediaRequest {
                    project_id: project.id.clone(),
                    revision: project.revision,
                },
            )
            .unwrap();
        assert!((prepared.duration - 2.0).abs() < 0.05);
        assert!(prepared.waveform.len() >= 190);
        assert!(prepared.waveform.iter().any(|peak| *peak > 0.2));

        let destination = directory.path().join("edited.m4a");
        let (_, export_record) = manager.create_job(JobKind::Export).unwrap();
        let exported = manager
            .run_export(
                None,
                &export_record,
                &projects,
                &ExportMediaRequest {
                    project_id: project.id,
                    revision: project.revision,
                    keep_ranges: vec![TimeRange {
                        start: 0.25,
                        end: 1.25,
                    }],
                    destination: ExportDestination {
                        destination: destination.to_string_lossy().into_owned(),
                        display_name: "edited.m4a".into(),
                    },
                },
                MediaKind::Audio,
            )
            .unwrap();
        assert!(exported.byte_length > 0);
        assert!(destination.exists());
    }
}
