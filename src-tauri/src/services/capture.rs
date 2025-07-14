use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt; // 用于设置文件权限
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::{Child, Command}; // 使用 Tokio 的 Command 和 Child
use tokio::sync::watch;

// eCapture 的 CLI 二进制数据
const ECAPTURE_BYTES: &[u8] = include_bytes!("../binaries/android_test-aarch64-linux-android");
const CLI_BINARY_NAME: &str = "android_test";

/// 负责管理 eCapture 子进程的整个生命周期
pub struct CaptureManager {
    executable_path: PathBuf,
    child: Option<Child>,
}
impl CaptureManager {
    pub fn new(base_path: impl AsRef<Path>) -> Self {
        let executable_path = base_path.as_ref().join(CLI_BINARY_NAME);
        Self {
            executable_path,
            child: None,
        }
    }

    fn prepare_binary(&self) -> Result<(), Box<dyn std::error::Error>> {
        if self.executable_path.exists() {
            fs::remove_file(&self.executable_path)?;
        }

        let mut dest_file = fs::File::create(&self.executable_path)?;
        dest_file.write_all(ECAPTURE_BYTES)?;
        dest_file.sync_all()?; // 确保内容刷入磁盘

        let mut perms = fs::metadata(&self.executable_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&self.executable_path, perms)?;

        println!("eCapture binary prepared at: {:?}", self.executable_path);
        Ok(())
    }

    fn cleanup(&self) -> std::io::Result<()> {
        println!("Cleaning up eCapture binary...");
        fs::remove_file(&self.executable_path)
    }

    pub async fn run(
        &mut self,
        mut shutdown_rx: watch::Receiver<()>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.prepare_binary()?;

        let binary_command = self.executable_path.to_string_lossy().to_string();
        let mut child = Command::new("su") // 使用 tokio::process::Command
            .arg("-c")
            .arg(&binary_command)
            .stdout(Stdio::null()) // 重定向输出
            .stderr(Stdio::null())
            .spawn()?;

        println!("eCapture process spawned with PID: {:?}", child.id());
        self.child = Some(child); // 将 child 存入 struct

        // 3. 使用 select! 同时等待关闭信号或进程自己退出
        tokio::select! {
            biased;

            _ = shutdown_rx.changed() => {
                if let Some(child_to_kill) = self.child.as_mut() {
                    child_to_kill.kill().await?;
                    println!("eCapture process killed.");
                }
            }

            result = self.child.as_mut().unwrap().wait() => {
                match result {
                    Ok(status) => eprintln!("eCapture process exited unexpectedly with status: {}", status),
                    Err(e) => eprintln!("Error waiting for eCapture process: {}", e),
                }
            }
        }

        // 4. 在任务结束时执行清理
        self.cleanup()?;
        Ok(())
    }
}
