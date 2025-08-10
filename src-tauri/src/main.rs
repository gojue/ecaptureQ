#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Create Tokio runtime
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to create Tokio runtime.");

    rt.block_on(async {
        ecaptureq_lib::run().await;
    });
}
