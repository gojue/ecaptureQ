mod core;
mod debug_logger;
mod services;
mod tauri_bridge;

use tauri_bridge::{commands, state::AppState};
use tokio::sync::Mutex;
use tokio::sync::{mpsc, watch};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    let (actor_tx, actor_rx) = mpsc::channel(128);
    let (done_tx, done_rx) = watch::channel(());
    let actor = core::actor::DataFrameActor::new(actor_rx, done_rx.clone())
        .expect("Failed to create DataFrameActor");
    tauri::async_runtime::spawn(actor.run());
    let df_actor_handle = core::actor::DataFrameActorHandle {
        sender: actor_tx,
        done: done_tx,
    };

    let app_state = AppState {
        df_actor_handle,
        shutdown_tx: Mutex::new(None),
        session_handles: Mutex::new(None),
        offset: Mutex::new(0),
    };

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            // 在这里，我们已经拥有了 AppHandle
            debug_logger::init(app.handle().clone());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![
            commands::start_capture,
            commands::stop_capture,
            commands::get_all_data,
            commands::get_incremental_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
