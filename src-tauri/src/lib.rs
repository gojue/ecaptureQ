mod core;
mod services;
mod tauri_bridge;

use std::{sync::Arc, thread, time::Duration};

use log::{error, info};
#[cfg(target_os = "linux")]
use nix::unistd::geteuid;
use tauri::{Manager, RunEvent};
use tauri_plugin_log::{Builder as LogBuilder, Target, TargetKind};
use tokio::sync::{Mutex, RwLock, mpsc, watch};

use crate::tauri_bridge::state::RunState;
use crate::tauri_bridge::{
    commands,
    state::{AppState, Configs},
};
// use tokio::signal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    // On Linux, only root user can run this program
    #[cfg(all(target_os = "linux", not(decoupled)))]
    {
        if !geteuid().is_root() {
            error!("NEED TO RUN WITH ROOT PERMISSION");
            std::process::exit(1);
        }
    }

    let (actor_tx, actor_rx) = mpsc::channel(128);
    let (done_tx, done_rx) = watch::channel(());
    let actor = core::actor::DataFrameActor::new(actor_rx, done_rx)
        .expect("Failed to create DataFrameActor");
    tauri::async_runtime::spawn(actor.run());
    let df_actor_handle = core::actor::DataFrameActorHandle {
        sender: actor_tx,
        done: done_tx.clone(),
    };

    let configs = Configs {
        ws_url: Some("ws://127.0.0.1:28257".to_string()),
        ecapture_args: Some(" tls --ecaptureq ws://127.0.0.1:28257".to_string()),
    };

    let app_state = AppState {
        df_actor_handle,
        done: Mutex::new(done_tx),
        shutdown_tx: Mutex::new(None),
        push_service_handle: Mutex::new(None),
        configs: Mutex::new(configs),
        status: Arc::new(RwLock::new(RunState::NotCapturing)),
    };

    let log_plugin = LogBuilder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            // Target::new(TargetKind::Webview),
        ])
        .level(log::LevelFilter::Info)
        .build();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle();
            let app_handle_clone = app_handle.clone();

            tokio::spawn(async move {
                if let Ok(_) = tokio::signal::ctrl_c().await {
                    app_handle_clone.exit(0);
                }
            });

            Ok(())
        })
        .manage(app_state)
        .plugin(log_plugin)
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::start_capture,
            commands::stop_capture,
            commands::get_configs,
            commands::modify_configs,
            commands::base64_decode,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            RunEvent::ExitRequested { api, .. } => {
                api.prevent_exit();
                info!("Exit requested. Starting graceful shutdown of capture session...");
                let app_handle_clone = app_handle.clone();

                tauri::async_runtime::spawn(async move {
                    let state: tauri::State<AppState> = app_handle_clone.state();
                    // state.session_handles.lock().await.take();
                    if commands::stop_capture(state).await.is_err() {
                        error!("Error stopping capture");
                    }
                });
                thread::sleep(Duration::from_millis(500));
                std::process::exit(1);
            }
            _ => {}
        }
    });
}
