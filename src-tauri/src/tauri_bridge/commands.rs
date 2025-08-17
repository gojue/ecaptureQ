use anyhow::Result;
use base64::{Engine as _, engine::general_purpose};
use log::{error, info};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tokio::time::{Duration, sleep};
use wg::AsyncWaitGroup;

#[cfg(all(not(decoupled), any(target_os = "linux", target_os = "android")))]
use crate::services::capture::CaptureManager;
use crate::services::{push_service::PushService, websocket::WebsocketService};
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

    *state.status.write().await = RunState::Capturing;

    let error_inspector = Arc::new(AtomicBool::new(false));

    // channel for capture session
    let (shutdown_tx, _) = tokio::sync::watch::channel(());

    // Get the app's data directory for storing the binary
    #[cfg(all(not(decoupled), any(target_os = "linux", target_os = "android")))]
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

    #[cfg(all(not(decoupled), any(target_os = "linux", target_os = "android")))]
    {
        let capture_error_inspector = error_inspector.clone();
        let mut capture_manager = CaptureManager::new(data_dir);

        let rx = shutdown_tx.subscribe();
        info!("Spawning background services...");

        // I love go-style waitgroup
        let capture_wg = AsyncWaitGroup::new();
        capture_wg.add(1);

        let capture_wg_clone = capture_wg.clone();
        // spawn ecapture service
        tokio::spawn(async move {
            let result = capture_manager
                .run(rx, configs.ecapture_args.unwrap_or_default())
                .await;

            if let Err(e) = result {
                error!("[CaptureManager] Task failed: {}", e);
                capture_error_inspector.store(true, Ordering::Release);
            }
            capture_wg_clone.done();
        });
        tokio::select! {
        _ = sleep(Duration::from_millis(900)) => {
            }

        _ = capture_wg.wait() => {
            }
        }
    }

    let ws_wg = AsyncWaitGroup::new();
    ws_wg.add(1);

    let ws_error_inspector = error_inspector.clone();

    let ws_wg_clone = ws_wg.clone();
    // spawn websocket listen service
    tokio::spawn(async move {
        if let Err(e) = websocket_service.receiver_task().await {
            error!("[WebsocketService] Task failed: {}", e);
            ws_error_inspector.store(true, Ordering::Release);
        }
        ws_wg_clone.done();
    });
    tokio::select! {
        _ = sleep(Duration::from_millis(100)) => {
            }

        _ = ws_wg.wait() => {
        }
    }

    if error_inspector.load(Ordering::SeqCst) {
        error!("capture session launch error");
        *state.status.write().await = RunState::NotCapturing;
        shutdown_tx
            .send(())
            .map_err(|_| "Failed to send shutdown signal.".to_string())?;
        return Err("capture session launch error".into());
    }

    // Handle push service - create if not exists, reuse if exists
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

    info!("Capture session started successfully.");
    Ok(())
}

#[tauri::command]
pub async fn stop_capture(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let RunState::NotCapturing = state.status.read().await.clone() {
        return Err("Capture session is already running.".into());
    }
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
    if base64String.is_empty() {
        return Err("Base64 string is empty".to_string());
    }

    let decoded_bytes_result = general_purpose::STANDARD
        .decode(&base64String)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    String::from_utf8(decoded_bytes_result.clone()).or_else(|_| {
        let total_len = decoded_bytes_result.len();
        let display_limit = 1024;


        let prefix = if total_len > display_limit {
            format!("(Preview of first {} bytes)\n", display_limit)
        } else {
            "".to_string()
        };

        let hex_dump = decoded_bytes_result
            .iter()
            .take(display_limit)
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
            .collect::<String>();

        Ok(format!(
            "{}Binary data ({} bytes):{}",
            prefix,
            total_len,
            hex_dump
        ))
    })
}
