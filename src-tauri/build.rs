use std::io::Result;

fn main() -> Result<()> {
    prost_build::compile_protos(&["src/protobuf/v1/ecaptureq.proto"], &["src/"])?;

    tauri_build::build();

    if std::env::var("DECOUPLED_MODE").map_or(false, |v| v == "true") {
        println!("cargo:rustc-cfg=decoupled");
    }
    Ok(())
}
