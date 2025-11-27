use anyhow::{Result, anyhow};
use log::{error, info};
use polars::{prelude::IntoLazy, sql::SQLContext};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tokio::time::{Duration, sleep};
use wg::AsyncWaitGroup;

use crate::core::{actor::create_capture_df, queries};
#[cfg(all(not(decoupled), any(target_os = "linux", target_os = "android")))]
use crate::services::capture::CaptureManager;
use crate::services::{push_service::PushService, websocket::WebsocketService};
use crate::tauri_bridge::state::{AppState, Configs, RunState};

#[tauri::command]
pub async fn start_capture(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if let RunState::Capturing = &*state.status.read().await {
        return Err("Capture session is already running.".into());
    }

    *state.status.write().await = RunState::Capturing;
    let error_inspector = Arc::new(AtomicBool::new(false));
    let (shutdown_tx, _) = tokio::sync::watch::channel(());

    #[cfg(all(not(decoupled), any(target_os = "linux", target_os = "android")))]
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let configs = {
        let guard = state.configs.lock().await;
        guard.clone()
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

    let shared_last_index_val = *state.shared_last_index.lock().await;
    let shared_last_index = state.shared_last_index.clone();

    let user_sql = { state.user_sql.lock().await.clone() };
    PushService::new(
        state.df_actor_handle.clone(),
        "packet-data".to_string(),
        user_sql,
        shared_last_index_val,
        shared_last_index,
        shutdown_tx.subscribe(),
        app_handle.clone(),
    )
    .map_err(|e| e.to_string())?;

    *state.shutdown_tx.lock().await = Some(shutdown_tx);

    info!("Capture session started successfully.");
    Ok(())
}

#[tauri::command]
pub async fn stop_capture(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let RunState::NotCapturing = &*state.status.read().await {
        return Err("Capture session is not running.".into());
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
    #[allow(non_snake_case)] mut newConfigs: Configs,
) -> Result<(), String> {
    // Normalize empty strings to None
    if let Some(ref user_sql) = newConfigs.user_sql {
        let trimmed = user_sql.trim();
        if trimmed.is_empty() {
            newConfigs.user_sql = None;
        } else {
            newConfigs.user_sql = Some(trimmed.to_string());
        }
    }

    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| "failed to get data directory".to_string())?;

    newConfigs
        .save_json_to_app_dir(&data_dir)
        .map_err(|_| "failed to save json")?;

    let loaded_configs =
        Configs::get_json_from_app_dir(&data_dir).map_err(|_| "failed to load json")?;
    state.init_configs(loaded_configs).await;

    Ok(())
}

#[tauri::command]
pub async fn verify_user_sql(user_sql: Option<String>) -> Result<(), String> {
    info!("triggered verify_user_sql");

    let normalized_user_sql = user_sql.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    if normalized_user_sql.is_none() {
        info!("user_sql is None after normalization, validation passed");
        return Ok(());
    }

    if let Some(ref sql_text) = normalized_user_sql {
        info!("Validating SQL: {}", sql_text);

        let mut ctx = SQLContext::new();
        let df = create_capture_df();
        ctx.register("packets", df.lazy());

        let zero_index: u64 = 0;
        let validation_sql = queries::new_packets_customized_no_payload(&zero_index, sql_text);

        ctx.execute(&validation_sql)
            .and_then(|lf| lf.collect())
            .map_err(|e| {
                error!("SQL validation failed: {}", e);
                format!("SQL validation failed: {}", e)
            })?;

        info!("SQL validation passed");
    }

    Ok(())
}

#[tauri::command]
pub async fn get_packet_with_payload(
    state: tauri::State<'_, AppState>,
    index: u64,
) -> Result<crate::core::models::PacketData, String> {
    let df_actor_handle = &state.df_actor_handle;
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
