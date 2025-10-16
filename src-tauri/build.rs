use std::io::Result;

fn main() -> Result<()> {
    prost_build::compile_protos(&["src/protobuf/v1/ecaptureq.proto"], &["src/"])?;

    tauri_build::build();

    if std::env::var("DECOUPLED_MODE").map_or(false, |v| v == "true") {
        println!("cargo:rustc-cfg=decoupled");
    }

    // Enable cross-compilation for pkg-config
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_ALLOW_CROSS");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    // SAFETY: This is called in a build script before any threads are spawned
    unsafe {
        std::env::set_var("PKG_CONFIG_ALLOW_CROSS", "1");
    }

    Ok(())
}
