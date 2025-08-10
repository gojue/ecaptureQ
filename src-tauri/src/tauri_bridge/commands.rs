use anyhow::Result;
use base64::{Engine as _, engine::general_purpose};
use log::{error, info};
use tauri::{Manager, State};

use crate::services::{
    capture::CaptureManager, push_service::PushService, websocket::WebsocketService,
};
use crate::tauri_bridge::state::{AppState, Configs, RunState};

#[tauri::command]
pub async fn start_capture(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Check if already running
    if let RunState::Capturing = state.status.read().await.clone() {
        return Err("Capture session is already running.".into());
    }

    let (shutdown_tx, _) = tokio::sync::watch::channel(());

    // Get the app's data directory for storing the binary
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let configs = {
        let guard = state.configs.lock().await;
        guard.clone() // Deep copy
    };
    let mut websocket_service = WebsocketService::new(
        configs.ws_url.unwrap(),
        state.df_actor_handle.clone(),
        shutdown_tx.subscribe(),
        state.status.clone(),
    )
    .map_err(|e| e.to_string())?;

    #[cfg(not(decoupled))]
    {
        let mut capture_manager = CaptureManager::new(data_dir, shutdown_tx.clone());

        let rx = shutdown_tx.subscribe();
        info!("Spawning background services...");
        // spawn ecapture service
        tokio::spawn(async move {
            if let Err(e) = capture_manager.run(rx).await {
                error!("[CaptureManager] Task failed: {}", e);
            }
        });
        // Wait for WebSocket setup
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }

    // spawn websocket listen service
    tokio::spawn(async move {
        if let Err(e) = websocket_service.receiver_task().await {
            error!("[WebsocketService] Task failed: {}", e);
        }
    }); // Handle push service - create if not exists, reuse if exists

    let mut handle_guard = state.push_service_handle.lock().await;
    let done_guard = state.done.lock().await;
    if handle_guard.is_none() {
        // Create new push service
        let new_handle = PushService::new(
            state.df_actor_handle.clone(),
            "packet-data".to_string(),
            "SELECT * FROM packets".to_string(),
            done_guard.subscribe(),
            app_handle.clone(),
        );
        *handle_guard = Some(new_handle);
    }

    *state.shutdown_tx.lock().await = Some(shutdown_tx);

    *state.status.write().await = RunState::Capturing;
    info!("Capture session started successfully.");
    Ok(())
}

#[tauri::command]
pub async fn stop_capture(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(shutdown_tx) = state.shutdown_tx.lock().await.take() {
        shutdown_tx
            .send(())
            .map_err(|_| "Failed to send shutdown signal.".to_string())?;

        info!("Shutdown signal sent. Capture session stopping.");
        *state.status.write().await = RunState::NotCapturing;
        Ok(())
    } else {
        Err("Capture session is not running.".into())
    }
}

#[tauri::command]
pub async fn get_configs(state: tauri::State<'_, AppState>) -> Result<Configs, String> {
    let configs_guard = state.configs.lock().await;
    Ok(configs_guard.clone())
}

#[tauri::command]
pub async fn modify_configs(
    state: tauri::State<'_, AppState>,
    patch: Configs,
) -> Result<(), String> {
    let mut configs_guard = state.configs.lock().await;
    configs_guard.apply_patch(patch);
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn base64_decode(base64String: String) -> Result<String, String> {
    // Check if empty or invalid
    if base64String.is_empty() {
        return Err("Base64 string is empty".to_string());
    }

    // Decode Base64
    let decoded_bytes_result = general_purpose::STANDARD
        .decode(&base64String)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    // Convert to UTF-8 string
    let utf8_string_result = String::from_utf8(decoded_bytes_result.clone())
        .or_else(|_| -> Result<String, std::string::FromUtf8Error> {
            // If not valid UTF-8, display as hex
            Ok(format!(
                "Binary data ({} bytes):\n{}",
                decoded_bytes_result.len(),
                decoded_bytes_result
                    .iter()
                    .take(256) // Show first 256 bytes only
                    .enumerate()
                    .map(|(i, b)| {
                        if i % 16 == 0 {
                            format!("\n{:04x}: {:02x}", i, b)
                        } else if i % 8 == 0 {
                            format!("  {:02x}", b)
                        } else {
                            format!(" {:02x}", b)
                        }
                    })
                    .collect::<String>()
            ))
        })
        .map_err(|e| format!("UTF-8 conversion error: {}", e))?;

    Ok(utf8_string_result)
}
