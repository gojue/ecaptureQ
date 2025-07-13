use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::process::Stdio;
use tokio::process;

pub async fn run_ecapture(filepath: std::path::PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let binary_content: &'static [u8] =
        include_bytes!("../binaries/android_test-aarch64-linux-android");
    let cli_binary_name = "android_test";
    let destination_path = filepath.join(cli_binary_name);
    if destination_path.exists() {
        if let Err(e) = fs::remove_file(&destination_path) {
            return Err(e.into());
        }
    }
    {
        let mut dest_file = match fs::File::create(&destination_path) {
            Ok(file) => file,
            Err(e) => return Err(format!("❌ 创建目标文件失败: {}", e).into()),
        };
        if let Err(e) = dest_file.write_all(&binary_content) {
            return Err(format!("❌ 写入目标文件失败: {}", e).into());
        }
        if let Err(e) = dest_file.sync_all() {
            return Err(format!("❌ 同步文件到磁盘失败: {}", e).into());
        }
    }

    let mut perms = std::fs::metadata(&destination_path)?.permissions();
    perms.set_mode(0o755);
    if let Err(e) = fs::set_permissions(&destination_path, perms) {
        return Err(e.into());
    }
    let binary_command = destination_path.to_string_lossy().to_string();
    let child = process::Command::new("su")
        .arg("-c")
        .arg(&binary_command)
        .stdout(Stdio::null()) // 关键：将标准输出重定向到“黑洞”(/dev/null)
        .stderr(Stdio::null()) // 同样可以处理标准错误
        .spawn()
        .expect("Failed to spawn");

    Ok(())
}
