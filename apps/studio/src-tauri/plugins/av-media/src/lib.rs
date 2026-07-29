#![cfg(mobile)]

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};
use thiserror::Error;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_av_media);

#[derive(Debug, Error)]
pub enum Error {
    #[error("mobile AV media plugin failed: {0}")]
    Plugin(#[from] tauri::plugin::mobile::PluginInvokeError),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparePayload {
    pub input_path: String,
    pub output_directory: String,
    pub audio_reference: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    pub input_path: String,
    pub destination: String,
    pub media_kind: String,
    pub keep_ranges: Vec<TimeRange>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobIdResponse {
    job_id: String,
}

pub struct AvMedia<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> AvMedia<R> {
    fn invoke<T: DeserializeOwned, P: Serialize>(&self, command: &str, payload: P) -> Result<T> {
        Ok(self.0.run_mobile_plugin(command, payload)?)
    }

    pub fn start_prepare(&self, payload: PreparePayload) -> Result<String> {
        self.invoke::<JobIdResponse, _>("startPrepare", payload)
            .map(|response| response.job_id)
    }

    pub fn start_export(&self, payload: ExportPayload) -> Result<String> {
        self.invoke::<JobIdResponse, _>("startExport", payload)
            .map(|response| response.job_id)
    }

    pub fn snapshot<T: DeserializeOwned>(&self, job_id: String) -> Result<Option<T>> {
        self.invoke("snapshot", serde_json::json!({ "jobId": job_id }))
    }

    pub fn cancel(&self, job_id: String) -> Result<()> {
        self.invoke("cancel", serde_json::json!({ "jobId": job_id }))
    }

    pub fn prepare_result<T: DeserializeOwned>(&self, job_id: String) -> Result<Option<T>> {
        self.invoke("prepareResult", serde_json::json!({ "jobId": job_id }))
    }

    pub fn export_result<T: DeserializeOwned>(&self, job_id: String) -> Result<Option<T>> {
        self.invoke("exportResult", serde_json::json!({ "jobId": job_id }))
    }
}

pub trait AvMediaExt<R: Runtime> {
    fn av_media(&self) -> &AvMedia<R>;
}

impl<R: Runtime, T: Manager<R>> AvMediaExt<R> for T {
    fn av_media(&self) -> &AvMedia<R> {
        self.state::<AvMedia<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("av-media")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_av_media)?;
            app.manage(AvMedia(handle));
            Ok(())
        })
        .build()
}
