use chrono;
use log::{Level, Log, Metadata, Record};
use serde::Serialize;
use std::sync::mpsc::{self, Sender};
use tauri::{AppHandle, Emitter, Manager};

const LOG_TAG: &str = "[ecq]";

#[derive(Debug, Clone, Serialize)]
struct LogEntry {
    message: String,
    level: String,
    timestamp: String,
    target: String,
    file: Option<String>,
    line: Option<u32>,
}

struct FrontendLogger {
    tx: Sender<LogEntry>,
}

impl Log for FrontendLogger {
    fn enabled(&self, _metadata: &Metadata) -> bool {
        true
    }

    fn log(&self, record: &Record) {
        // 将日志参数转换为字符串
        let message = format!("{}", record.args());

        if message.starts_with(LOG_TAG) {
            let clean_message = message
                .strip_prefix(LOG_TAG)
                .unwrap_or(&message)
                .trim_start();

            let log_entry = LogEntry {
                message: clean_message.to_string(),
                level: record.level().to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                target: record.target().to_string(),
                file: record.file().map(String::from),
                line: record.line(),
            };

            let _ = self.tx.send(log_entry);
        }
    }

    fn flush(&self) {}
}

pub fn init(app_handle: AppHandle) {
    let (tx, rx) = mpsc::channel::<LogEntry>();

    // ✅ 第四步：简化 logger 的创建过程
    let logger = FrontendLogger { tx };

    log::set_boxed_logger(Box::new(logger)).expect("Failed to set logger");
    log::set_max_level(Level::Trace.to_level_filter());

    // 使用新的方式发送初始化日志
    log::info!(
        "{} 自定义前端日志记录器已初始化。现在请使用 `log::info!(\"{}\", ...)` 格式来发送日志。",
        LOG_TAG,
        LOG_TAG
    );

    tauri::async_runtime::spawn(async move {
        while let Ok(log_entry) = rx.recv() {
            if let Err(e) = app_handle.emit("log://log", &log_entry) {
                eprintln!("Failed to emit log to frontend: {}", e);
            }
        }
        println!("Log listener task has shut down.");
    });
}

pub fn log_to_frontend(app_handle: &AppHandle, level: &str, message: &str) {
    // 3. 创建 LogEntry 实例作为 payload
    let payload = LogEntry {
        message: message.to_string(),
        level: level.to_uppercase(),
        timestamp: chrono::Utc::now().to_rfc3339(),

        target: "manual_log".to_string(), // 使用一个固定的 target
        file: None,                       // 无法自动获取文件名
        line: None,                       // 无法自动获取行号
    };

    if let Err(e) = app_handle.emit("log://log", &payload) {
        eprintln!("Failed to send log to frontend: {}", e);
    }
}
