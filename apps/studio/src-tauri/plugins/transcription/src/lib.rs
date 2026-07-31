#![cfg(mobile)]

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};
use thiserror::Error;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_transcription);

#[derive(Debug, Error)]
pub enum Error {
    #[error("mobile transcription plugin failed: {0}")]
    Plugin(#[from] tauri::plugin::mobile::PluginInvokeError),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPayload {
    pub audio_path: String,
    pub model: String,
    pub language: Option<String>,
    pub speaker_diarization_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobIdResponse {
    job_id: String,
}

pub struct Transcription<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Transcription<R> {
    fn invoke<T: DeserializeOwned, P: Serialize>(&self, command: &str, payload: P) -> Result<T> {
        Ok(self.0.run_mobile_plugin(command, payload)?)
    }

    pub fn start(&self, payload: StartPayload) -> Result<String> {
        self.invoke::<JobIdResponse, _>("start", payload)
            .map(|response| response.job_id)
    }

    pub fn snapshot<T: DeserializeOwned>(&self, job_id: String) -> Result<Option<T>> {
        self.invoke("snapshot", serde_json::json!({ "jobId": job_id }))
    }

    pub fn cancel(&self, job_id: String) -> Result<()> {
        self.invoke("cancel", serde_json::json!({ "jobId": job_id }))
    }

    pub fn result<T: DeserializeOwned>(&self, job_id: String) -> Result<Option<T>> {
        self.invoke("result", serde_json::json!({ "jobId": job_id }))
    }

    pub fn list_models<T: DeserializeOwned>(&self) -> Result<T> {
        self.invoke("listModels", serde_json::json!({}))
    }

    pub fn remove_model(&self, model: String) -> Result<()> {
        self.invoke("removeModel", serde_json::json!({ "model": model }))
    }
}

pub trait TranscriptionExt<R: Runtime> {
    fn transcription(&self) -> &Transcription<R>;
}

impl<R: Runtime, T: Manager<R>> TranscriptionExt<R> for T {
    fn transcription(&self) -> &Transcription<R> {
        self.state::<Transcription<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("transcription")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_transcription)?;
            app.manage(Transcription(handle));
            Ok(())
        })
        .build()
}
