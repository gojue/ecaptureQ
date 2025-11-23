use anyhow::{Result, anyhow};
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
    if let RunState::Capturing = &*state.status.read().await {
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
        configs.as_ref().unwrap().ws_url.clone().unwrap(),
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
                .run(
                    rx,
                    configs
                        .as_ref()
                        .unwrap()
                        .ecapture_args
                        .clone()
                        .unwrap_or_default(),
                )
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
    if let RunState::NotCapturing = &*state.status.read().await {
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
pub async fn get_configs(
    _app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Configs, String> {
    let configs = state.configs.lock().await;
    if !configs.is_none() {
        return Ok(configs.clone().unwrap());
    }
    Err("config is none".to_string())
}

#[tauri::command]
pub async fn modify_configs(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    mut patch: Configs,
) -> Result<(), String> {
    /*let mut configs_guard = state.configs.lock().await;
    configs_guard.apply_patch(patch);*/
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| "failed to get data directory".to_string())?;

    let configs = state.configs.lock().await.clone();
    if let Some(mut config) = configs {
        config.apply_patch(&mut patch);
        config
            .save_json_to_app_dir(&data_dir)
            .map_err(|_| "failed to save json")?;
        let loaded_configs =
            Configs::get_json_from_app_dir(&data_dir).map_err(|_| "failed to load json")?;
        state.init_configs(loaded_configs).await;
        return Ok(());
    }
    Err("config is none".to_string())
}

#[tauri::command]
pub async fn get_packet_with_payload(
    state: tauri::State<'_, AppState>,
    index: u64,
) -> Result<crate::core::models::PacketData, String> {
    let df_actor_handle = &state.df_actor_handle;

    // Use actor method to get packet by index
    let df_result = df_actor_handle.get_packet_by_index(index).await;

    match df_result {
        Ok(df) => {
            if df.height() == 0 {
                return Err("Packet not found".to_string());
            }

            let packets = crate::tauri_bridge::converters::df_to_packet_data_vec(&df)
                .map_err(|e| e.to_string())?;

            if let Some(packet) = packets.into_iter().next() {
                Ok(packet)
            } else {
                Err("Failed to convert packet data".to_string())
            }
        }
        Err(e) => Err(format!("Database query failed: {}", e)),
    }
}
