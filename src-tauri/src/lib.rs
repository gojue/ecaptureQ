mod core;
mod services;
mod tauri_bridge;

use tauri_bridge::{commands, state::AppState};
use tauri::{Manager, RunEvent};
use tokio::sync::Mutex;
use tokio::sync::{mpsc, watch};
use tauri_plugin_log::{Builder as LogBuilder, Target, TargetKind};
use nix::unistd::geteuid;
use std::thread;
use std::time::Duration;
// use tokio::signal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    // on linux, only root user can run this program
    #[cfg(target_os = "linux")]
    {
        if !geteuid().is_root() {
            eprintln!("NEED TO RUN WITH ROOT PERMISSION");
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
        done: done_tx,
    };

    let app_state = AppState {
        df_actor_handle,
        shutdown_tx: Mutex::new(None),
        session_handles: Mutex::new(None),
        offset: Mutex::new(0),
    };

    let log_plugin = LogBuilder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            // Target::new(TargetKind::Webview),
        ])
        .level(log::LevelFilter::Info)
        .build();

    /*    tauri::Builder::default()
        .manage(app_state)
        .plugin(log_plugin)
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
        .expect("error while running tauri application");*/
    let builder = tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![
            commands::start_capture,
            commands::stop_capture,
            commands::get_all_data,
            commands::get_incremental_data,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {

        match event {
            RunEvent::ExitRequested { api, .. } => {
                api.prevent_exit();
                println!("Exit requested. Starting graceful shutdown of capture session...");
                let app_handle_clone = app_handle.clone();

                tauri::async_runtime::spawn(async move {
                    let state: tauri::State<AppState> = app_handle_clone.state();
                    // state.session_handles.lock().await.take();
                    if commands::stop_capture(state).await.is_err() {
                        eprintln!("error stop capture");
                    }
                });
                thread::sleep(Duration::from_secs(1));
                std::process::exit(1);
            }
            _ => {}

        }

    });
}
