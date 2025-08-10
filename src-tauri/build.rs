fn main() {
    tauri_build::build();

    if std::env::var("DECOUPLED_MODE").map_or(false, |v| v == "true") {
        println!("cargo:rustc-cfg=decoupled");
    }
}
