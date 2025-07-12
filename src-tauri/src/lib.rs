use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

#[tauri::command]
async fn open_settings_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    // 在移动平台上，多窗口支持有限，我们简化这个功能
    #[cfg(mobile)]
    {
        // 在移动平台上，通常不支持多窗口，返回成功但不执行任何操作
        return Ok(());
    }
    
    #[cfg(not(mobile))]
    {
        let settings_window = app_handle.get_webview_window("settings");
        
        match settings_window {
            Some(window) => {
                window.show().map_err(|e| e.to_string())?;
                window.set_focus().map_err(|e| e.to_string())?;
            }
            None => {
                tauri::WebviewWindowBuilder::new(
                    &app_handle,
                    "settings",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Settings")
                .inner_size(600.0, 500.0)
                .min_inner_size(500.0, 400.0)
                .center()
                .build()
                .map_err(|e| e.to_string())?;
            }
        }
    }
    
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![open_settings_window])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
