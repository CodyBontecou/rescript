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
    #[error("mobile AV media plugin returned an invalid response: {0}")]
    InvalidResponse(String),
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartExportResponse {
    job_id: Option<String>,
    purchase_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartExportOutcome {
    Started(String),
    PurchaseRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEntitlementState {
    pub enforcement: String,
    pub entitled: bool,
    pub product_id: String,
    pub display_price: Option<String>,
    pub can_purchase: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEntitlementCheck {
    pub entitled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPurchaseResult {
    pub outcome: String,
    pub entitlement: ExportEntitlementState,
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

    pub fn start_export(&self, payload: ExportPayload) -> Result<StartExportOutcome> {
        self.invoke::<StartExportResponse, _>("startExport", payload)
            .and_then(|response| {
                if response.purchase_required {
                    Ok(StartExportOutcome::PurchaseRequired)
                } else if let Some(job_id) = response.job_id {
                    Ok(StartExportOutcome::Started(job_id))
                } else {
                    Err(Error::InvalidResponse(
                        "native export returned neither a job ID nor a purchase requirement".into(),
                    ))
                }
            })
    }

    pub fn export_entitlement_status(&self) -> Result<ExportEntitlementState> {
        self.invoke("exportEntitlementStatus", serde_json::json!({}))
    }

    pub fn is_export_entitled(&self) -> Result<bool> {
        self.invoke::<ExportEntitlementCheck, _>("isExportEntitled", serde_json::json!({}))
            .map(|response| response.entitled)
    }

    pub fn purchase_unlimited_exports(&self) -> Result<ExportPurchaseResult> {
        self.invoke("purchaseUnlimitedExports", serde_json::json!({}))
    }

    pub fn restore_export_purchases(&self) -> Result<ExportPurchaseResult> {
        self.invoke("restoreExportPurchases", serde_json::json!({}))
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
