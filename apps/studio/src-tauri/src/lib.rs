mod file_authority;
mod media_jobs;
mod project_store;
#[cfg(not(target_os = "ios"))]
mod transcription_jobs;

use file_authority::{AuthorityKind, FileAuthority};
use media_jobs::{
    ExportMediaRequest, JobProgress, MediaExportResult, MediaJobError, MediaJobManager,
    PrepareMediaRequest, PreparedMedia,
};
use project_store::{
    CreateProjectInput, ImportedMediaInfo, ImportedTranscript, ProjectManifest, ProjectStore,
    ProjectStoreError, ProjectSummary, SaveProjectInput,
};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FileAccessMode, PickerMode};
#[cfg(not(target_os = "ios"))]
use transcription_jobs::{
    ModelDescriptor, TranscriptionError, TranscriptionJobManager, TranscriptionRequest,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: &'static str,
    arch: &'static str,
    mobile: bool,
}

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        mobile: cfg!(mobile),
    }
}

async fn blocking<T, F>(operation: F) -> Result<T, ProjectStoreError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ProjectStoreError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| ProjectStoreError::FileSystem {
            message: format!("background file task failed: {error}"),
        })?
}

#[tauri::command]
async fn list_projects(
    store: tauri::State<'_, ProjectStore>,
) -> Result<Vec<ProjectSummary>, ProjectStoreError> {
    let store = store.inner().clone();
    blocking(move || store.list()).await
}

#[tauri::command]
async fn read_project(
    store: tauri::State<'_, ProjectStore>,
    id: String,
) -> Result<Option<ProjectManifest>, ProjectStoreError> {
    let store = store.inner().clone();
    blocking(move || store.read(&id)).await
}

#[tauri::command]
async fn create_project(
    store: tauri::State<'_, ProjectStore>,
    authority: tauri::State<'_, FileAuthority>,
    mut input: CreateProjectInput,
) -> Result<ProjectManifest, ProjectStoreError> {
    input.source_path = authority
        .consume(&input.source_path, AuthorityKind::MediaImport)?
        .to_string_lossy()
        .into_owned();
    let store = store.inner().clone();
    blocking(move || store.create(input)).await
}

#[tauri::command]
async fn save_project(
    store: tauri::State<'_, ProjectStore>,
    input: SaveProjectInput,
) -> Result<ProjectManifest, ProjectStoreError> {
    let store = store.inner().clone();
    blocking(move || store.save(input)).await
}

#[tauri::command]
async fn delete_project(
    store: tauri::State<'_, ProjectStore>,
    id: String,
) -> Result<(), ProjectStoreError> {
    let store = store.inner().clone();
    blocking(move || store.remove(&id)).await
}

#[tauri::command]
async fn project_media_path(
    store: tauri::State<'_, ProjectStore>,
    id: String,
) -> Result<String, ProjectStoreError> {
    let store = store.inner().clone();
    blocking(move || store.media_path(&id)).await
}

fn selected_path(selection: tauri_plugin_dialog::FilePath) -> Result<PathBuf, ProjectStoreError> {
    selection
        .into_path()
        .map_err(|error| ProjectStoreError::InvalidInput {
            message: format!("selected file is not a local path: {error}"),
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeExportDestination {
    destination: String,
    display_name: String,
}

#[tauri::command]
async fn pick_native_media(
    app: AppHandle,
    authority: tauri::State<'_, FileAuthority>,
) -> Result<Option<ImportedMediaInfo>, ProjectStoreError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose audio or video")
        .set_picker_mode(PickerMode::Document)
        .set_file_access_mode(FileAccessMode::Copy)
        .add_filter(
            "Audio and video",
            &[
                "mp4", "mov", "m4v", "webm", "mkv", "avi", "mp3", "m4a", "wav", "aac", "flac",
                "ogg",
            ],
        )
        .pick_file(move |selection| {
            let _ = sender.send(selection);
        });
    let Some(selection) = receiver.await.map_err(|_| ProjectStoreError::FileSystem {
        message: "native media picker closed unexpectedly".into(),
    })?
    else {
        return Ok(None);
    };
    let path = selected_path(selection)?;
    let inspect_path = path.to_string_lossy().into_owned();
    let mut info = blocking(move || project_store::inspect_media(&inspect_path)).await?;
    info.source = authority.grant(path, AuthorityKind::MediaImport)?;
    Ok(Some(info))
}

#[tauri::command]
async fn pick_native_transcript(
    app: AppHandle,
) -> Result<Option<ImportedTranscript>, ProjectStoreError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose transcript")
        .set_picker_mode(PickerMode::Document)
        .set_file_access_mode(FileAccessMode::Copy)
        .add_filter("Transcript", &["srt", "vtt", "json"])
        .pick_file(move |selection| {
            let _ = sender.send(selection);
        });
    let Some(selection) = receiver.await.map_err(|_| ProjectStoreError::FileSystem {
        message: "native transcript picker closed unexpectedly".into(),
    })?
    else {
        return Ok(None);
    };
    let path = selected_path(selection)?;
    let transcript_path = path.to_string_lossy().into_owned();
    blocking(move || project_store::read_transcript(&transcript_path))
        .await
        .map(Some)
}

#[tauri::command]
async fn pick_export_destination(
    app: AppHandle,
    authority: tauri::State<'_, FileAuthority>,
    suggested_name: String,
    media_kind: project_store::MediaKind,
) -> Result<Option<NativeExportDestination>, ProjectStoreError> {
    let extension = match media_kind {
        project_store::MediaKind::Audio => "m4a",
        project_store::MediaKind::Video => "mp4",
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Export edited media")
        .set_file_name(&suggested_name)
        .add_filter(
            if extension == "m4a" {
                "M4A audio"
            } else {
                "MP4 video"
            },
            &[extension],
        )
        .save_file(move |selection| {
            let _ = sender.send(selection);
        });
    let Some(selection) = receiver.await.map_err(|_| ProjectStoreError::FileSystem {
        message: "native export picker closed unexpectedly".into(),
    })?
    else {
        return Ok(None);
    };
    let mut path = selected_path(selection)?;
    if path.extension().and_then(|value| value.to_str()) != Some(extension) {
        path.set_extension(extension);
    }
    if !path.is_absolute() {
        return Err(ProjectStoreError::InvalidInput {
            message: "export destination must be absolute".into(),
        });
    }
    let display_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&suggested_name)
        .to_string();
    let destination = authority.grant(path, AuthorityKind::Export)?;
    Ok(Some(NativeExportDestination {
        destination,
        display_name,
    }))
}

#[tauri::command]
#[allow(unused_variables)]
fn start_prepare_media(
    app: AppHandle,
    jobs: tauri::State<'_, MediaJobManager>,
    projects: tauri::State<'_, ProjectStore>,
    request: PrepareMediaRequest,
) -> Result<String, MediaJobError> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_av_media::{AvMediaExt, PreparePayload};
        let manifest =
            projects
                .read(&request.project_id)?
                .ok_or_else(|| MediaJobError::InvalidInput {
                    message: "project does not exist".into(),
                })?;
        if manifest.revision != request.revision {
            return Err(MediaJobError::InvalidInput {
                message: "project revision changed before media preparation".into(),
            });
        }
        let input_path = projects.media_path(&request.project_id)?;
        let output_directory = projects
            .derived_directory(&request.project_id, request.revision)?
            .to_string_lossy()
            .into_owned();
        return app
            .av_media()
            .start_prepare(PreparePayload {
                input_path,
                output_directory,
                audio_reference: format!(
                    "project:{}:revision:{}:audio-16k.wav",
                    request.project_id, request.revision
                ),
            })
            .map_err(|error| MediaJobError::Failed {
                message: error.to_string(),
            });
    }
    #[cfg(not(target_os = "ios"))]
    {
        jobs.start_prepare(app, projects.inner().clone(), request)
    }
}

#[tauri::command]
#[allow(unused_variables)]
fn start_export_media(
    app: AppHandle,
    jobs: tauri::State<'_, MediaJobManager>,
    projects: tauri::State<'_, ProjectStore>,
    authority: tauri::State<'_, FileAuthority>,
    mut request: ExportMediaRequest,
) -> Result<String, MediaJobError> {
    request.destination.destination = authority
        .consume(&request.destination.destination, AuthorityKind::Export)
        .map_err(|error| MediaJobError::InvalidInput {
            message: error.to_string(),
        })?
        .to_string_lossy()
        .into_owned();
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_av_media::{AvMediaExt, ExportPayload, TimeRange};
        let manifest =
            projects
                .read(&request.project_id)?
                .ok_or_else(|| MediaJobError::InvalidInput {
                    message: "project does not exist".into(),
                })?;
        if manifest.revision != request.revision {
            return Err(MediaJobError::InvalidInput {
                message: "project revision changed before export".into(),
            });
        }
        if request.keep_ranges.is_empty()
            || request
                .keep_ranges
                .iter()
                .any(|range| range.end > manifest.duration + 0.0001)
        {
            return Err(MediaJobError::InvalidInput {
                message: "export ranges are empty or exceed project duration".into(),
            });
        }
        return app
            .av_media()
            .start_export(ExportPayload {
                input_path: projects.media_path(&request.project_id)?,
                destination: request.destination.destination,
                media_kind: match manifest.media.media_kind {
                    project_store::MediaKind::Video => "video".into(),
                    project_store::MediaKind::Audio => "audio".into(),
                },
                keep_ranges: request
                    .keep_ranges
                    .into_iter()
                    .map(|range| TimeRange {
                        start: range.start,
                        end: range.end,
                    })
                    .collect(),
            })
            .map_err(|error| MediaJobError::Failed {
                message: error.to_string(),
            });
    }
    #[cfg(not(target_os = "ios"))]
    {
        jobs.start_export(app, projects.inner().clone(), request)
    }
}

#[tauri::command]
#[allow(unused_variables)]
fn media_job_snapshot(
    app: AppHandle,
    jobs: tauri::State<'_, MediaJobManager>,
    job_id: String,
) -> Result<Option<JobProgress>, MediaJobError> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_av_media::AvMediaExt;
        return app
            .av_media()
            .snapshot(job_id)
            .map_err(|error| MediaJobError::Failed {
                message: error.to_string(),
            });
    }
    #[cfg(not(target_os = "ios"))]
    {
        jobs.snapshot(&job_id)
    }
}

#[tauri::command]
#[allow(unused_variables)]
fn cancel_media_job(
    app: AppHandle,
    jobs: tauri::State<'_, MediaJobManager>,
    job_id: String,
) -> Result<(), MediaJobError> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_av_media::AvMediaExt;
        return app
            .av_media()
            .cancel(job_id)
            .map_err(|error| MediaJobError::Failed {
                message: error.to_string(),
            });
    }
    #[cfg(not(target_os = "ios"))]
    {
        jobs.cancel(&job_id)
    }
}

#[tauri::command]
#[allow(unused_variables)]
fn media_prepare_result(
    app: AppHandle,
    jobs: tauri::State<'_, MediaJobManager>,
    job_id: String,
) -> Result<Option<PreparedMedia>, MediaJobError> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_av_media::AvMediaExt;
        return app
            .av_media()
            .prepare_result(job_id)
            .map_err(|error| MediaJobError::Failed {
                message: error.to_string(),
            });
    }
    #[cfg(not(target_os = "ios"))]
    {
        jobs.prepare_result(&job_id)
    }
}

#[tauri::command]
#[allow(unused_variables)]
fn media_export_result(
    app: AppHandle,
    jobs: tauri::State<'_, MediaJobManager>,
    job_id: String,
) -> Result<Option<MediaExportResult>, MediaJobError> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_av_media::AvMediaExt;
        return app
            .av_media()
            .export_result(job_id)
            .map_err(|error| MediaJobError::Failed {
                message: error.to_string(),
            });
    }
    #[cfg(not(target_os = "ios"))]
    {
        jobs.export_result(&job_id)
    }
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn start_transcription(
    app: AppHandle,
    jobs: tauri::State<'_, TranscriptionJobManager>,
    projects: tauri::State<'_, ProjectStore>,
    request: TranscriptionRequest,
) -> Result<String, TranscriptionError> {
    jobs.start(app, projects.inner().clone(), request)
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn transcription_job_snapshot(
    jobs: tauri::State<'_, TranscriptionJobManager>,
    job_id: String,
) -> Result<Option<JobProgress>, TranscriptionError> {
    jobs.snapshot(&job_id)
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn cancel_transcription_job(
    jobs: tauri::State<'_, TranscriptionJobManager>,
    job_id: String,
) -> Result<(), TranscriptionError> {
    jobs.cancel(&job_id)
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn transcription_result(
    jobs: tauri::State<'_, TranscriptionJobManager>,
    job_id: String,
) -> Result<Option<Vec<project_store::Word>>, TranscriptionError> {
    jobs.result(&job_id)
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn list_native_models(jobs: tauri::State<'_, TranscriptionJobManager>) -> Vec<ModelDescriptor> {
    jobs.list_models()
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn remove_native_model(
    jobs: tauri::State<'_, TranscriptionJobManager>,
    model: project_store::ModelChoice,
) -> Result<(), TranscriptionError> {
    jobs.remove_model(model)
}

#[cfg(target_os = "ios")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IosTranscriptionRequest {
    project_id: String,
    revision: u64,
    model: project_store::ModelChoice,
    language: Option<String>,
}

#[cfg(target_os = "ios")]
fn ios_transcription_error(error: impl std::fmt::Display) -> MediaJobError {
    MediaJobError::Failed {
        message: error.to_string(),
    }
}

#[cfg(target_os = "ios")]
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IosModelDescriptor {
    model: project_store::ModelChoice,
    label: String,
    byte_length: u64,
    availability: String,
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn start_transcription(
    app: AppHandle,
    projects: tauri::State<'_, ProjectStore>,
    request: IosTranscriptionRequest,
) -> Result<String, MediaJobError> {
    use tauri_plugin_transcription::{StartPayload, TranscriptionExt};
    if request.model == project_store::ModelChoice::Import {
        return Err(MediaJobError::InvalidInput {
            message: "import is not a native transcription model".into(),
        });
    }
    let project =
        projects
            .read(&request.project_id)?
            .ok_or_else(|| MediaJobError::InvalidInput {
                message: "project does not exist".into(),
            })?;
    if project.revision != request.revision {
        return Err(MediaJobError::InvalidInput {
            message: "project revision changed before transcription".into(),
        });
    }
    let audio_path = projects
        .prepared_audio_path(&request.project_id, request.revision)?
        .to_string_lossy()
        .into_owned();
    app.transcription()
        .start(StartPayload {
            audio_path,
            model: match request.model {
                project_store::ModelChoice::Base => "base".into(),
                project_store::ModelChoice::Small => "small".into(),
                project_store::ModelChoice::ParakeetV2 => "parakeet-v2".into(),
                project_store::ModelChoice::ParakeetV3 => "parakeet-v3".into(),
                project_store::ModelChoice::Import => unreachable!(),
            },
            language: request.language,
        })
        .map_err(ios_transcription_error)
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn transcription_job_snapshot(
    app: AppHandle,
    job_id: String,
) -> Result<Option<JobProgress>, MediaJobError> {
    use tauri_plugin_transcription::TranscriptionExt;
    app.transcription()
        .snapshot(job_id)
        .map_err(ios_transcription_error)
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn cancel_transcription_job(app: AppHandle, job_id: String) -> Result<(), MediaJobError> {
    use tauri_plugin_transcription::TranscriptionExt;
    app.transcription()
        .cancel(job_id)
        .map_err(ios_transcription_error)
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn transcription_result(
    app: AppHandle,
    job_id: String,
) -> Result<Option<Vec<project_store::Word>>, MediaJobError> {
    use tauri_plugin_transcription::TranscriptionExt;
    app.transcription()
        .result(job_id)
        .map_err(ios_transcription_error)
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn list_native_models(app: AppHandle) -> Result<Vec<IosModelDescriptor>, MediaJobError> {
    use tauri_plugin_transcription::TranscriptionExt;
    app.transcription()
        .list_models()
        .map_err(ios_transcription_error)
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn remove_native_model(
    app: AppHandle,
    model: project_store::ModelChoice,
) -> Result<(), MediaJobError> {
    use tauri_plugin_transcription::TranscriptionExt;
    let model = match model {
        project_store::ModelChoice::Base => "base",
        project_store::ModelChoice::Small => "small",
        project_store::ModelChoice::ParakeetV2 => "parakeet-v2",
        project_store::ModelChoice::ParakeetV3 => "parakeet-v3",
        project_store::ModelChoice::Import => {
            return Err(MediaJobError::InvalidInput {
                message: "import is not a native model".into(),
            })
        }
    };
    app.transcription()
        .remove_model(model.into())
        .map_err(ios_transcription_error)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "ios")]
    let builder = builder
        .plugin(tauri_plugin_av_media::init())
        .plugin(tauri_plugin_transcription::init());

    builder
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            let resource_dir = app.path().resource_dir()?;
            app.manage(FileAuthority::default());
            app.manage(ProjectStore::new(app_data.join("projects"))?);
            app.manage(MediaJobManager::new(
                app_data.join("jobs"),
                resource_dir.clone(),
            )?);
            #[cfg(not(target_os = "ios"))]
            app.manage(TranscriptionJobManager::new(
                app_data.join("transcription-jobs"),
                app_data.join("models"),
                resource_dir,
            )?);
            Ok(())
        })
        .on_window_event(|_window, _event| {
            #[cfg(not(target_os = "ios"))]
            if let tauri::WindowEvent::Destroyed = _event {
                _window.state::<TranscriptionJobManager>().cancel_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            platform_info,
            list_projects,
            read_project,
            create_project,
            save_project,
            delete_project,
            project_media_path,
            pick_native_media,
            pick_native_transcript,
            pick_export_destination,
            start_prepare_media,
            start_export_media,
            media_job_snapshot,
            cancel_media_job,
            media_prepare_result,
            media_export_result,
            start_transcription,
            transcription_job_snapshot,
            cancel_transcription_job,
            transcription_result,
            list_native_models,
            remove_native_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rescript Studio");
}
