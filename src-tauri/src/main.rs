#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 创建 Tokio 运行时
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to create Tokio runtime.");

    rt.block_on(async {
        ecaptureq_lib::run().await;
    });
}
