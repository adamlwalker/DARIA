//! Update commands stay registered so older frontends don't break, but this
//! build never contacts a remote (this fork does not poll an upstream repo).

use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub url: Option<String>,
    pub notes: Option<String>,
}

/// Always reports "no update" — no network call.
#[tauri::command]
pub async fn check_update() -> UpdateInfo {
    UpdateInfo {
        available: false,
        current: env!("CARGO_PKG_VERSION").to_string(),
        latest: env!("CARGO_PKG_VERSION").to_string(),
        url: None,
        notes: None,
    }
}

/// Disabled: this build does not download or launch remote installers.
#[tauri::command]
pub async fn run_update(_app: tauri::AppHandle, _url: String) -> Result<(), String> {
    Err("remote updates are disabled".into())
}
