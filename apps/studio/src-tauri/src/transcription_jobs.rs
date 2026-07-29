#![cfg(not(target_os = "ios"))]

use crate::{
    media_jobs::{JobKind, JobProgress, JobStatus, JOB_PROGRESS_EVENT},
    project_store::{ModelChoice, ProjectStore, ProjectStoreError, Word},
};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
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

const MODEL_REPOSITORY: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TranscriptionError {
    #[error("invalid transcription job: {message}")]
    InvalidInput { message: String },
    #[error("transcription job not found: {job_id}")]
    NotFound { job_id: String },
    #[error("native transcription tool is unavailable: {message}")]
    ToolUnavailable { message: String },
    #[error("transcription failed: {message}")]
    Failed { message: String },
    #[error("transcription was cancelled")]
    Cancelled,
}

impl From<std::io::Error> for TranscriptionError {
    fn from(value: std::io::Error) -> Self {
        Self::Failed {
            message: value.to_string(),
        }
    }
}

impl From<ProjectStoreError> for TranscriptionError {
    fn from(value: ProjectStoreError) -> Self {
        Self::InvalidInput {
            message: value.to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionRequest {
    pub project_id: String,
    pub revision: u64,
    pub model: ModelChoice,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDescriptor {
    pub model: ModelChoice,
    pub label: String,
    pub byte_length: u64,
    pub availability: String,
}

#[derive(Clone, Copy)]
struct ModelSpec {
    model: ModelChoice,
    file_name: &'static str,
    label: &'static str,
    byte_length: u64,
    sha256: &'static str,
}

const WHISPER_MODELS: [ModelSpec; 2] = [
    ModelSpec {
        model: ModelChoice::Base,
        file_name: "ggml-base.bin",
        label: "Whisper Base",
        byte_length: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    ModelSpec {
        model: ModelChoice::Small,
        file_name: "ggml-small.bin",
        label: "Whisper Small",
        byte_length: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    },
];

#[derive(Clone, Copy)]
struct ParakeetSpec {
    model: ModelChoice,
    version: &'static str,
    folder_name: &'static str,
    label: &'static str,
    byte_length: u64,
}

const PARAKEET_MODELS: [ParakeetSpec; 2] = [
    ParakeetSpec {
        model: ModelChoice::ParakeetV2,
        version: "v2",
        folder_name: "parakeet-tdt-0.6b-v2",
        label: "Parakeet v2",
        byte_length: 464_066_490,
    },
    ParakeetSpec {
        model: ModelChoice::ParakeetV3,
        version: "v3",
        folder_name: "parakeet-tdt-0.6b-v3",
        label: "Parakeet v3",
        // FluidAudio downloads only the required Core ML components. The
        // descriptor is an approximate UI size; readiness is directory-based.
        byte_length: 465_000_000,
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionJournal {
    progress: JobProgress,
    words: Option<Vec<Word>>,
}

struct TranscriptionRecord {
    journal: Mutex<TranscriptionJournal>,
    cancel: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl TranscriptionRecord {
    fn new(job_id: String) -> Self {
        Self {
            journal: Mutex::new(TranscriptionJournal {
                progress: JobProgress {
                    job_id,
                    kind: JobKind::Transcription,
                    status: JobStatus::Queued,
                    phase: "queued".into(),
                    message: "Queued".into(),
                    ratio: Some(0.0),
                },
                words: None,
            }),
            cancel: AtomicBool::new(false),
            child: Mutex::new(None),
        }
    }
}

#[derive(Clone)]
pub struct TranscriptionJobManager {
    root: PathBuf,
    models: PathBuf,
    records: Arc<Mutex<HashMap<String, Arc<TranscriptionRecord>>>>,
    whisper_cli: PathBuf,
    parakeet_cli: PathBuf,
    client: Client,
}

impl TranscriptionJobManager {
    pub fn new(
        root: PathBuf,
        models: PathBuf,
        resource_dir: PathBuf,
    ) -> Result<Self, TranscriptionError> {
        fs::create_dir_all(&root)?;
        fs::create_dir_all(&models)?;
        let manager = Self {
            root,
            models,
            records: Arc::new(Mutex::new(HashMap::new())),
            whisper_cli: whisper_tool(&resource_dir),
            parakeet_cli: parakeet_tool(&resource_dir),
            client: Client::builder()
                .connect_timeout(Duration::from_secs(20))
                .timeout(Duration::from_secs(60 * 30))
                .user_agent("Rescript/0.1 native model manager")
                .build()
                .map_err(|error| TranscriptionError::Failed {
                    message: error.to_string(),
                })?,
        };
        manager.restore_journals()?;
        Ok(manager)
    }

    pub fn list_models(&self) -> Vec<ModelDescriptor> {
        let mut models: Vec<ModelDescriptor> = WHISPER_MODELS
            .iter()
            .map(|specification| ModelDescriptor {
                model: specification.model,
                label: specification.label.into(),
                byte_length: specification.byte_length,
                availability: if self.whisper_model_is_ready(specification) {
                    "ready".into()
                } else {
                    "missing".into()
                },
            })
            .collect();
        models.extend(PARAKEET_MODELS.iter().map(|specification| ModelDescriptor {
            model: specification.model,
            label: specification.label.into(),
            byte_length: specification.byte_length,
            availability: if self.parakeet_model_is_ready(specification) {
                "ready".into()
            } else {
                "missing".into()
            },
        }));
        models
    }

    pub fn remove_model(&self, model: ModelChoice) -> Result<(), TranscriptionError> {
        if let Ok(specification) = whisper_model_spec(model) {
            remove_if_exists(&self.models.join(specification.file_name))?;
            remove_if_exists(
                &self
                    .models
                    .join(format!("{}.sha256", specification.file_name)),
            )?;
            return Ok(());
        }
        let specification = parakeet_model_spec(model)?;
        // Never remove shared FluidAudio or Vox caches. Model removal owns only
        // the copy downloaded below Rescript's app-data directory.
        remove_directory_if_exists(&self.managed_parakeet_model_directory(&specification))
    }

    pub fn start(
        &self,
        app: AppHandle,
        projects: ProjectStore,
        request: TranscriptionRequest,
    ) -> Result<String, TranscriptionError> {
        if request.model == ModelChoice::Import {
            return Err(TranscriptionError::InvalidInput {
                message: "import is not a native transcription model".into(),
            });
        }
        let project = projects.read(&request.project_id)?.ok_or_else(|| {
            TranscriptionError::InvalidInput {
                message: "project does not exist".into(),
            }
        })?;
        if project.revision != request.revision {
            return Err(TranscriptionError::InvalidInput {
                message: "project revision changed before transcription".into(),
            });
        }
        projects.prepared_audio_path(&request.project_id, request.revision)?;

        let job_id = Uuid::new_v4().to_string();
        let record = Arc::new(TranscriptionRecord::new(job_id.clone()));
        self.records
            .lock()
            .map_err(|_| lock_error())?
            .insert(job_id.clone(), record.clone());
        self.persist(&record);

        let manager = self.clone();
        thread::spawn(move || {
            manager.update(
                Some(&app),
                &record,
                JobStatus::Running,
                "model",
                "Checking offline model",
                Some(0.01),
            );
            match manager.run_transcription(Some(&app), &record, &projects, &request) {
                Ok(words) => manager.complete(&app, &record, words),
                Err(TranscriptionError::Cancelled) => manager.update(
                    Some(&app),
                    &record,
                    JobStatus::Cancelled,
                    "cancelled",
                    "Transcription cancelled",
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

    pub fn snapshot(&self, job_id: &str) -> Result<Option<JobProgress>, TranscriptionError> {
        let record = self.record(job_id)?;
        let progress = record
            .journal
            .lock()
            .map_err(|_| lock_error())?
            .progress
            .clone();
        Ok(Some(progress))
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), TranscriptionError> {
        let record = self.record(job_id)?;
        record.cancel.store(true, Ordering::Release);
        Self::terminate_child(&record)?;
        Ok(())
    }

    pub fn cancel_all(&self) {
        let records = self
            .records
            .lock()
            .map(|records| records.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for record in records {
            record.cancel.store(true, Ordering::Release);
            let _ = Self::terminate_child(&record);
        }
    }

    pub fn result(&self, job_id: &str) -> Result<Option<Vec<Word>>, TranscriptionError> {
        let record = self.record(job_id)?;
        let words = record
            .journal
            .lock()
            .map_err(|_| lock_error())?
            .words
            .clone();
        Ok(words)
    }

    fn run_transcription(
        &self,
        app: Option<&AppHandle>,
        record: &Arc<TranscriptionRecord>,
        projects: &ProjectStore,
        request: &TranscriptionRequest,
    ) -> Result<Vec<Word>, TranscriptionError> {
        match request.model {
            ModelChoice::Base | ModelChoice::Small => {
                self.run_whisper_transcription(app, record, projects, request)
            }
            ModelChoice::ParakeetV2 | ModelChoice::ParakeetV3 => {
                self.run_parakeet_transcription(app, record, projects, request)
            }
            ModelChoice::Import => Err(TranscriptionError::InvalidInput {
                message: "import is not a native transcription model".into(),
            }),
        }
    }

    fn run_whisper_transcription(
        &self,
        app: Option<&AppHandle>,
        record: &Arc<TranscriptionRecord>,
        projects: &ProjectStore,
        request: &TranscriptionRequest,
    ) -> Result<Vec<Word>, TranscriptionError> {
        ensure_tool(&self.whisper_cli, "whisper-cli")?;
        let specification = whisper_model_spec(request.model)?;
        let model = self.ensure_model(app, record, specification)?;
        if record.cancel.load(Ordering::Acquire) {
            return Err(TranscriptionError::Cancelled);
        }
        let audio = projects.prepared_audio_path(&request.project_id, request.revision)?;
        let derived = projects.derived_directory(&request.project_id, request.revision)?;
        let output_base = derived.join("whisper-transcript");
        let output_json = output_base.with_extension("json");
        let progress_log = derived.join(".transcription-progress.txt");
        remove_if_exists(&output_json)?;
        remove_if_exists(&progress_log)?;

        let stderr = File::create(&progress_log)?;
        let threads = std::thread::available_parallelism()
            .map(|count| count.get().clamp(1, 8))
            .unwrap_or(4);
        let language = request.language.as_deref().unwrap_or("auto");
        let child = Command::new(&self.whisper_cli)
            .args([
                "-m",
                &model.to_string_lossy(),
                "-f",
                &audio.to_string_lossy(),
                "-ojf",
                "-of",
                &output_base.to_string_lossy(),
                "-l",
                language,
                "-ml",
                "1",
                "-sow",
                "-pp",
                "-t",
                &threads.to_string(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr))
            .spawn()
            .map_err(|error| TranscriptionError::ToolUnavailable {
                message: format!("cannot launch whisper-cli: {error}"),
            })?;
        Self::install_child(record, child)?;
        let mut last = 0.4;
        loop {
            if record.cancel.load(Ordering::Acquire) {
                Self::terminate_child(record)?;
                return Err(TranscriptionError::Cancelled);
            }
            if let Some(status) = Self::poll_child(record)? {
                if !status.success() {
                    return Err(TranscriptionError::Failed {
                        message: tail_file(&progress_log, 8_000)
                            .unwrap_or_else(|| format!("whisper-cli exited with {status}")),
                    });
                }
                break;
            }
            if let Some(percent) = read_whisper_progress(&progress_log) {
                let ratio = 0.4 + percent.clamp(0.0, 100.0) / 100.0 * 0.58;
                if ratio >= last + 0.005 {
                    last = ratio;
                    self.update(
                        app,
                        record,
                        JobStatus::Running,
                        "transcribe",
                        "Transcribing locally",
                        Some(ratio),
                    );
                }
            }
            thread::sleep(Duration::from_millis(150));
        }

        self.update(
            app,
            record,
            JobStatus::Running,
            "parse",
            "Finalizing word timestamps",
            Some(0.99),
        );
        let json = fs::read(&output_json).map_err(|error| TranscriptionError::Failed {
            message: format!("whisper-cli did not produce JSON: {error}"),
        })?;
        let words = parse_whisper_json(&json)?;
        if words.is_empty() {
            return Err(TranscriptionError::Failed {
                message: "Whisper returned an empty transcript".into(),
            });
        }
        remove_if_exists(&progress_log)?;
        Ok(words)
    }

    fn run_parakeet_transcription(
        &self,
        app: Option<&AppHandle>,
        record: &Arc<TranscriptionRecord>,
        projects: &ProjectStore,
        request: &TranscriptionRequest,
    ) -> Result<Vec<Word>, TranscriptionError> {
        ensure_tool(&self.parakeet_cli, "fluidaudiocli")?;
        let specification = parakeet_model_spec(request.model)?;
        let model_directory = self.ready_parakeet_model_directory(&specification);
        let model_ready = model_directory.is_some();
        self.update(
            app,
            record,
            JobStatus::Running,
            if model_ready {
                "model"
            } else {
                "model-download"
            },
            if model_ready {
                "Loading offline Parakeet model"
            } else {
                "Downloading Parakeet model"
            },
            if model_ready { Some(0.35) } else { None },
        );
        if record.cancel.load(Ordering::Acquire) {
            return Err(TranscriptionError::Cancelled);
        }

        let audio = projects.prepared_audio_path(&request.project_id, request.revision)?;
        let derived = projects.derived_directory(&request.project_id, request.revision)?;
        let output_json = derived.join("parakeet-transcript.json");
        let progress_log = derived.join(".parakeet-progress.txt");
        remove_if_exists(&output_json)?;
        remove_if_exists(&progress_log)?;

        let stdout = File::create(&progress_log)?;
        let stderr = stdout.try_clone()?;
        let mut command = Command::new(&self.parakeet_cli);
        command.args([
            "transcribe",
            &audio.to_string_lossy(),
            "--model-version",
            specification.version,
            "--output-json",
            &output_json.to_string_lossy(),
        ]);
        // FluidAudio's v3 long-form path must disable mel-context prepending;
        // otherwise multilingual audio can drift toward English at chunk seams.
        if specification.model == ModelChoice::ParakeetV3 {
            command.arg("--no-mel-context");
        }
        if let Some(language) = request.language.as_deref() {
            command.args(["--language", language]);
        }
        if let Some(directory) = model_directory {
            // Load an existing app-managed, standard FluidAudio, or Vox cache
            // directly. The external caches remain read-only from Rescript's
            // perspective and are never removed by model management.
            command.arg("--model-dir").arg(directory);
        } else {
            // Keep first-use downloads app-scoped instead of writing into the
            // user's shared FluidAudio cache.
            fs::create_dir_all(self.parakeet_home())?;
            command.env("HOME", self.parakeet_home());
        }
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn()
            .map_err(|error| TranscriptionError::ToolUnavailable {
                message: format!("cannot launch fluidaudiocli: {error}"),
            })?;
        Self::install_child(record, child)?;

        self.update(
            app,
            record,
            JobStatus::Running,
            "transcribe",
            "Transcribing locally with Parakeet",
            Some(0.4),
        );
        loop {
            if record.cancel.load(Ordering::Acquire) {
                Self::terminate_child(record)?;
                return Err(TranscriptionError::Cancelled);
            }
            if let Some(status) = Self::poll_child(record)? {
                if !status.success() || !output_json.exists() {
                    return Err(TranscriptionError::Failed {
                        message: tail_file(&progress_log, 8_000)
                            .unwrap_or_else(|| format!("fluidaudiocli exited with {status}")),
                    });
                }
                break;
            }
            thread::sleep(Duration::from_millis(150));
        }

        self.update(
            app,
            record,
            JobStatus::Running,
            "parse",
            "Finalizing word timestamps",
            Some(0.99),
        );
        let words = parse_parakeet_json(&fs::read(&output_json)?)?;
        if words.is_empty() {
            return Err(TranscriptionError::Failed {
                message: "Parakeet returned an empty transcript".into(),
            });
        }
        remove_if_exists(&progress_log)?;
        Ok(words)
    }

    fn ensure_model(
        &self,
        app: Option<&AppHandle>,
        record: &Arc<TranscriptionRecord>,
        specification: ModelSpec,
    ) -> Result<PathBuf, TranscriptionError> {
        let destination = self.models.join(specification.file_name);
        if self.whisper_model_is_ready(&specification) {
            self.update(
                app,
                record,
                JobStatus::Running,
                "transcribe",
                "Loading offline model",
                Some(0.4),
            );
            return Ok(destination);
        }

        let temporary = self.models.join(format!(
            ".{}.{}.download",
            specification.file_name,
            Uuid::new_v4()
        ));
        let url = format!("{MODEL_REPOSITORY}/{}", specification.file_name);
        let mut response = self
            .client
            .get(url)
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|error| TranscriptionError::Failed {
                message: format!("model download failed: {error}"),
            })?;
        let mut output = File::create(&temporary)?;
        let mut hash = Sha256::new();
        let mut downloaded = 0_u64;
        let mut buffer = vec![0_u8; 256 * 1024];
        loop {
            if record.cancel.load(Ordering::Acquire) {
                drop(output);
                let _ = remove_if_exists(&temporary);
                return Err(TranscriptionError::Cancelled);
            }
            let count = response
                .read(&mut buffer)
                .map_err(|error| TranscriptionError::Failed {
                    message: format!("model download interrupted: {error}"),
                })?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            hash.update(&buffer[..count]);
            downloaded += count as u64;
            let ratio = (downloaded as f64 / specification.byte_length as f64).clamp(0.0, 1.0);
            self.update(
                app,
                record,
                JobStatus::Running,
                "model-download",
                &format!("Downloading {}", specification.label),
                Some(0.02 + ratio * 0.36),
            );
        }
        output.sync_all()?;
        drop(output);
        if downloaded != specification.byte_length {
            let _ = remove_if_exists(&temporary);
            return Err(TranscriptionError::Failed {
                message: format!(
                    "model size mismatch: expected {}, received {downloaded}",
                    specification.byte_length
                ),
            });
        }
        let actual = format!("{:x}", hash.finalize());
        if actual != specification.sha256 {
            let _ = remove_if_exists(&temporary);
            return Err(TranscriptionError::Failed {
                message: "model checksum verification failed".into(),
            });
        }
        replace_file(&temporary, &destination)?;
        fs::write(
            self.models
                .join(format!("{}.sha256", specification.file_name)),
            format!("{}\n", specification.sha256),
        )?;
        Ok(destination)
    }

    fn whisper_model_is_ready(&self, specification: &ModelSpec) -> bool {
        let path = self.models.join(specification.file_name);
        let checksum = self
            .models
            .join(format!("{}.sha256", specification.file_name));
        path.metadata()
            .map(|metadata| metadata.len() == specification.byte_length)
            .unwrap_or(false)
            && fs::read_to_string(checksum)
                .map(|value| value.trim() == specification.sha256)
                .unwrap_or(false)
    }

    fn parakeet_home(&self) -> PathBuf {
        self.models.join("parakeet")
    }

    fn managed_parakeet_model_directory(&self, specification: &ParakeetSpec) -> PathBuf {
        self.parakeet_home()
            .join("Library")
            .join("Application Support")
            .join("FluidAudio")
            .join("Models")
            .join(specification.folder_name)
    }

    fn parakeet_model_directories(&self, specification: &ParakeetSpec) -> Vec<PathBuf> {
        let mut directories = vec![self.managed_parakeet_model_directory(specification)];

        if let Some(configured) = std::env::var_os("RESCRIPT_PARAKEET_MODEL_DIR") {
            let configured = PathBuf::from(configured);
            directories.push(
                if configured.file_name().and_then(|name| name.to_str())
                    == Some(specification.folder_name)
                {
                    configured
                } else {
                    configured.join(specification.folder_name)
                },
            );
        }

        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            directories.push(
                home.join("Library")
                    .join("Application Support")
                    .join("FluidAudio")
                    .join("Models")
                    .join(specification.folder_name),
            );
            directories.push(
                home.join("Library")
                    .join("Group Containers")
                    .join("group.bontecou.Voxboard")
                    .join("WhisperModels")
                    .join(specification.folder_name),
            );
        }

        directories.dedup();
        directories
    }

    fn ready_parakeet_model_directory(&self, specification: &ParakeetSpec) -> Option<PathBuf> {
        self.parakeet_model_directories(specification)
            .into_iter()
            .find(|directory| parakeet_directory_is_ready(directory, specification))
    }

    fn parakeet_model_is_ready(&self, specification: &ParakeetSpec) -> bool {
        self.ready_parakeet_model_directory(specification).is_some()
    }

    fn install_child(
        record: &Arc<TranscriptionRecord>,
        child: Child,
    ) -> Result<(), TranscriptionError> {
        let mut slot = record.child.lock().map_err(|_| lock_error())?;
        *slot = Some(child);
        Ok(())
    }

    fn poll_child(
        record: &Arc<TranscriptionRecord>,
    ) -> Result<Option<ExitStatus>, TranscriptionError> {
        let mut slot = record.child.lock().map_err(|_| lock_error())?;
        let status = match slot.as_mut() {
            Some(child) => child.try_wait()?,
            None => return Ok(None),
        };
        if status.is_some() {
            slot.take();
        }
        Ok(status)
    }

    fn terminate_child(record: &Arc<TranscriptionRecord>) -> Result<(), TranscriptionError> {
        let mut slot = record.child.lock().map_err(|_| lock_error())?;
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    fn record(&self, job_id: &str) -> Result<Arc<TranscriptionRecord>, TranscriptionError> {
        self.records
            .lock()
            .map_err(|_| lock_error())?
            .get(job_id)
            .cloned()
            .ok_or_else(|| TranscriptionError::NotFound {
                job_id: job_id.into(),
            })
    }

    fn update(
        &self,
        app: Option<&AppHandle>,
        record: &Arc<TranscriptionRecord>,
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

    fn complete(&self, app: &AppHandle, record: &Arc<TranscriptionRecord>, words: Vec<Word>) {
        if let Ok(mut journal) = record.journal.lock() {
            journal.words = Some(words);
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

    fn persist(&self, record: &Arc<TranscriptionRecord>) {
        let Ok(journal) = record.journal.lock() else {
            return;
        };
        let path = self.root.join(format!("{}.json", journal.progress.job_id));
        let _ = write_json_replace(&path, &*journal);
    }

    fn restore_journals(&self) -> Result<(), TranscriptionError> {
        let mut records = self.records.lock().map_err(|_| lock_error())?;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(mut journal) = serde_json::from_slice::<TranscriptionJournal>(&bytes) else {
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
                Arc::new(TranscriptionRecord {
                    journal: Mutex::new(journal),
                    cancel: AtomicBool::new(false),
                    child: Mutex::new(None),
                }),
            );
        }
        Ok(())
    }
}

fn whisper_model_spec(model: ModelChoice) -> Result<ModelSpec, TranscriptionError> {
    WHISPER_MODELS
        .iter()
        .find(|specification| specification.model == model)
        .copied()
        .ok_or_else(|| TranscriptionError::InvalidInput {
            message: "unknown native Whisper model".into(),
        })
}

fn parakeet_model_spec(model: ModelChoice) -> Result<ParakeetSpec, TranscriptionError> {
    PARAKEET_MODELS
        .iter()
        .find(|specification| specification.model == model)
        .copied()
        .ok_or_else(|| TranscriptionError::InvalidInput {
            message: "unknown native Parakeet model".into(),
        })
}

fn parakeet_directory_is_ready(directory: &Path, specification: &ParakeetSpec) -> bool {
    let required = [
        "Preprocessor.mlmodelc",
        "Encoder.mlmodelc",
        "Decoder.mlmodelc",
        if specification.model == ModelChoice::ParakeetV3 {
            "JointDecisionv3.mlmodelc"
        } else {
            "JointDecision.mlmodelc"
        },
        "parakeet_vocab.json",
    ];
    required.iter().all(|name| directory.join(name).exists())
}

fn whisper_tool(resource_dir: &Path) -> PathBuf {
    if let Ok(path) = std::env::var("RESCRIPT_WHISPER_CLI") {
        return PathBuf::from(path);
    }
    let bundled = resource_dir.join("bin").join("whisper-cli");
    if bundled.exists() {
        return bundled;
    }
    #[cfg(target_os = "macos")]
    for path in [
        "/opt/homebrew/bin/whisper-cli",
        "/usr/local/bin/whisper-cli",
    ] {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("whisper-cli")
}

fn parakeet_tool(resource_dir: &Path) -> PathBuf {
    if let Ok(path) = std::env::var("RESCRIPT_FLUIDAUDIO_CLI") {
        return PathBuf::from(path);
    }
    let bundled = resource_dir.join("bin").join("fluidaudiocli");
    if bundled.exists() {
        return bundled;
    }
    #[cfg(target_os = "macos")]
    for path in [
        "/opt/homebrew/bin/fluidaudiocli",
        "/usr/local/bin/fluidaudiocli",
    ] {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("fluidaudiocli")
}

fn ensure_tool(path: &Path, name: &str) -> Result<(), TranscriptionError> {
    Command::new(path)
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| TranscriptionError::ToolUnavailable {
            message: format!(
                "{name} is required for this model. Bundle it in resources/bin or configure its RESCRIPT_*_CLI override ({error})"
            ),
        })?;
    Ok(())
}

fn read_whisper_progress(path: &Path) -> Option<f64> {
    let text = fs::read_to_string(path).ok()?;
    text.lines().rev().find_map(|line| {
        let marker = "progress =";
        let from = line.find(marker)? + marker.len();
        line[from..]
            .trim()
            .trim_end_matches('%')
            .trim()
            .parse::<f64>()
            .ok()
    })
}

fn parse_whisper_json(bytes: &[u8]) -> Result<Vec<Word>, TranscriptionError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| TranscriptionError::Failed {
            message: format!("Whisper JSON is invalid: {error}"),
        })?;
    let segments = value
        .get("transcription")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TranscriptionError::Failed {
            message: "Whisper JSON has no transcription array".into(),
        })?;
    let mut words = Vec::new();
    for segment in segments {
        let segment_start = offset_seconds(segment, "from").unwrap_or(0.0);
        let segment_end = offset_seconds(segment, "to").unwrap_or(segment_start + 0.1);
        let mut added_token = false;
        if let Some(tokens) = segment.get("tokens").and_then(serde_json::Value::as_array) {
            for token in tokens {
                let text = token
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if is_special_token(text) {
                    continue;
                }
                let start = offset_seconds(token, "from").unwrap_or(segment_start);
                let end = offset_seconds(token, "to").unwrap_or(segment_end);
                added_token |= append_timed_text(&mut words, text, start, end);
            }
        }
        if !added_token {
            let text = segment
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            append_timed_text(&mut words, text, segment_start, segment_end);
        }
    }
    for (index, word) in words.iter_mut().enumerate() {
        word.id = index as u64;
    }
    Ok(words)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParakeetOutput {
    word_timings: Vec<ParakeetWordTiming>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParakeetWordTiming {
    word: String,
    start_time: f64,
    end_time: f64,
}

fn parse_parakeet_json(bytes: &[u8]) -> Result<Vec<Word>, TranscriptionError> {
    let output: ParakeetOutput =
        serde_json::from_slice(bytes).map_err(|error| TranscriptionError::Failed {
            message: format!("Parakeet JSON is invalid: {error}"),
        })?;
    Ok(output
        .word_timings
        .into_iter()
        .filter_map(|timing| {
            let text = timing.word.trim();
            if text.is_empty() || !timing.start_time.is_finite() || !timing.end_time.is_finite() {
                return None;
            }
            let start = timing.start_time.max(0.0);
            let end = timing.end_time.max(start + 0.01);
            Some(Word {
                id: 0,
                text: text.into(),
                start,
                end,
                speaker: 0,
                deleted: false,
            })
        })
        .enumerate()
        .map(|(id, mut word)| {
            word.id = id as u64;
            word
        })
        .collect())
}

fn offset_seconds(value: &serde_json::Value, key: &str) -> Option<f64> {
    value
        .get("offsets")?
        .get(key)?
        .as_f64()
        .map(|milliseconds| milliseconds / 1000.0)
}

fn append_timed_text(words: &mut Vec<Word>, text: &str, start: f64, end: f64) -> bool {
    let trimmed = text.trim();
    if !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|character| !character.is_alphanumeric())
    {
        if let Some(previous) = words.last_mut() {
            previous.text.push_str(trimmed);
            previous.end = previous.end.max(end);
            return true;
        }
    }
    let pieces: Vec<_> = text
        .split_whitespace()
        .filter(|piece| !piece.is_empty())
        .collect();
    if pieces.is_empty() {
        return false;
    }
    let safe_start = start.max(0.0);
    let safe_end = end.max(safe_start + 0.02);
    let span = safe_end - safe_start;
    for (index, piece) in pieces.iter().enumerate() {
        let piece_start = safe_start + span * index as f64 / pieces.len() as f64;
        let piece_end = safe_start + span * (index + 1) as f64 / pieces.len() as f64;
        words.push(Word {
            id: words.len() as u64,
            text: (*piece).into(),
            start: piece_start,
            end: piece_end.max(piece_start + 0.01),
            speaker: 0,
            deleted: false,
        });
    }
    true
}

fn is_special_token(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.is_empty()
        || (trimmed.starts_with("<|") && trimmed.ends_with("|>"))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
}

fn tail_file(path: &Path, maximum: usize) -> Option<String> {
    let mut bytes = Vec::new();
    File::open(path).ok()?.read_to_end(&mut bytes).ok()?;
    let from = bytes.len().saturating_sub(maximum);
    Some(String::from_utf8_lossy(&bytes[from..]).trim().into())
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), TranscriptionError> {
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    fs::rename(source, destination)?;
    Ok(())
}

fn write_json_replace<T: Serialize>(path: &Path, value: &T) -> Result<(), TranscriptionError> {
    let parent = path.parent().ok_or_else(|| TranscriptionError::Failed {
        message: "transcription journal has no parent".into(),
    })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec(value).map_err(|error| TranscriptionError::Failed {
            message: error.to_string(),
        })?,
    )?;
    replace_file(&temporary, path)
}

fn remove_directory_if_exists(path: &Path) -> Result<(), TranscriptionError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn remove_if_exists(path: &Path) -> Result<(), TranscriptionError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn lock_error() -> TranscriptionError {
    TranscriptionError::Failed {
        message: "transcription job state lock was poisoned".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_word_tokens_and_punctuation() {
        let json = br#"{
          "transcription": [{
            "offsets": {"from": 0, "to": 1000},
            "text": " Hello world.",
            "tokens": [
              {"text": " Hello", "offsets": {"from": 0, "to": 400}},
              {"text": " world", "offsets": {"from": 400, "to": 900}},
              {"text": ".", "offsets": {"from": 900, "to": 1000}}
            ]
          }]
        }"#;
        let words = parse_whisper_json(json).unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Hello");
        assert_eq!(words[1].text, "world.");
        assert!((words[1].end - 1.0).abs() < 0.001);
    }

    #[test]
    fn parses_segment_fallback() {
        let json = br#"{
          "transcription": [{
            "offsets": {"from": 1000, "to": 3000},
            "text": "one two three"
          }]
        }"#;
        let words = parse_whisper_json(json).unwrap();
        assert_eq!(words.len(), 3);
        assert_eq!(words[0].start, 1.0);
        assert_eq!(words[2].end, 3.0);
    }

    #[test]
    fn parses_parakeet_word_timings() {
        let json = br#"{
          "audioFile": "audio.wav",
          "modelVersion": "v3",
          "text": "Hello world.",
          "wordTimings": [
            {"word": "Hello", "startTime": 0.1, "endTime": 0.4, "confidence": 0.9},
            {"word": "world.", "startTime": 0.4, "endTime": 0.9, "confidence": 0.8}
          ]
        }"#;
        let words = parse_parakeet_json(json).unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[1].text, "world.");
        assert!((words[0].start - 0.1).abs() < 0.001);
        assert!((words[1].end - 0.9).abs() < 0.001);
    }

    #[test]
    fn recognizes_complete_parakeet_v2_directory() {
        let specification = parakeet_model_spec(ModelChoice::ParakeetV2).unwrap();
        let directory = tempfile::tempdir().unwrap();
        for name in [
            "Preprocessor.mlmodelc",
            "Encoder.mlmodelc",
            "Decoder.mlmodelc",
            "JointDecision.mlmodelc",
        ] {
            fs::create_dir_all(directory.path().join(name)).unwrap();
        }
        fs::write(directory.path().join("parakeet_vocab.json"), "{}").unwrap();

        assert!(parakeet_directory_is_ready(
            directory.path(),
            &specification
        ));
        fs::remove_file(directory.path().join("parakeet_vocab.json")).unwrap();
        assert!(!parakeet_directory_is_ready(
            directory.path(),
            &specification
        ));
    }

    #[test]
    fn requires_v3_joint_model_for_parakeet_v3() {
        let specification = parakeet_model_spec(ModelChoice::ParakeetV3).unwrap();
        let directory = tempfile::tempdir().unwrap();
        for name in [
            "Preprocessor.mlmodelc",
            "Encoder.mlmodelc",
            "Decoder.mlmodelc",
            "JointDecision.mlmodelc",
        ] {
            fs::create_dir_all(directory.path().join(name)).unwrap();
        }
        fs::write(directory.path().join("parakeet_vocab.json"), "{}").unwrap();

        assert!(!parakeet_directory_is_ready(
            directory.path(),
            &specification
        ));
        fs::create_dir_all(directory.path().join("JointDecisionv3.mlmodelc")).unwrap();
        assert!(parakeet_directory_is_ready(
            directory.path(),
            &specification
        ));
    }

    #[test]
    fn reads_cli_progress_lines() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("progress");
        fs::write(&path, "whisper_print_progress_callback: progress =  42%\n").unwrap();
        assert_eq!(read_whisper_progress(&path), Some(42.0));
    }
}
