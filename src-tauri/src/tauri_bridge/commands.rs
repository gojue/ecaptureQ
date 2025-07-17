use crate::core::models::PacketData;
use crate::services::capture::CaptureManager;
use crate::services::websocket::WebsocketService;
use crate::tauri_bridge::{
    converters::df_to_packet_data_vec, state::AppState, state::CaptureSessionHandles,
};
use tauri::{Manager, State};

#[tauri::command]
pub async fn get_all_data(state: State<'_, AppState>) -> Result<Vec<PacketData>, String> {
    let df = state
        .df_actor_handle
        .get_all_packets()
        .await
        .map_err(|e| e.to_string())?;
    // update offset
    let mut offset_guard = state.offset.lock().await;
    *offset_guard = df.height();
    println!("Offset initialized to: {}", *offset_guard);

    df_to_packet_data_vec(&df).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_incremental_data(state: State<'_, AppState>) -> Result<Vec<PacketData>, String> {
    let mut offset_guard = state.offset.lock().await;
    let current_offset = *offset_guard;

    let new_df = state
        .df_actor_handle
        .get_packets_by_offset(current_offset)
        .await
        .map_err(|e| e.to_string())?;

    let new_rows_count = new_df.height();

    if new_rows_count > 0 {
        // update offset
        *offset_guard += new_rows_count;
        println!(
            "Fetched {} new rows. New offset: {}",
            new_rows_count, *offset_guard
        );
    }

    df_to_packet_data_vec(&new_df).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_capture(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // check if it is already running
    if state.session_handles.lock().await.is_some() {
        return Err("Capture session is already running.".into());
    }

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(());

    // Get the app's data directory for storing the binary
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let mut capture_manager = CaptureManager::new(data_dir);

    let ws_url = "ws://127.0.0.1:18088/ws".to_string();
    let mut websocket_service =
        WebsocketService::new(ws_url, state.df_actor_handle.clone(), shutdown_rx.clone())
            .map_err(|e| e.to_string())?;

    println!("Spawning background services...");
    let capture_handle = tokio::spawn(async move {
        if let Err(e) = capture_manager.run(shutdown_rx).await {
            eprintln!("[CaptureManager] Task failed: {}", e);
        }
    });

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let websocket_handle = tokio::spawn(async move {
        if let Err(e) = websocket_service.receiver_task().await {
            eprintln!("[WebsocketService] Task failed: {}", e);
        }
    });

    // Update Shared State
    *state.session_handles.lock().await = Some(CaptureSessionHandles {
        capture_manager_handle: capture_handle,
        websocket_service_handle: websocket_handle,
    });
    *state.shutdown_tx.lock().await = Some(shutdown_tx);

    println!("Capture session started successfully.");
    Ok(())
}

#[tauri::command]
pub async fn stop_capture(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(shutdown_tx) = state.shutdown_tx.lock().await.take() {
        shutdown_tx
            .send(())
            .map_err(|_| "Failed to send shutdown signal.".to_string())?;

        state.session_handles.lock().await.take();

        println!("Shutdown signal sent. Capture session stopping.");
        Ok(())
    } else {
        Err("Capture session is not running.".into())
    }
}
