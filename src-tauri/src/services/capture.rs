use std::path::{Path, PathBuf};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt; // 用于设置文件权限
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command}; // 使用 Tokio 的 Command 和 Child
use tokio::sync::watch;
use nix::sys::signal::{Signal, kill as send_signal};
use nix::unistd::Pid;
use sha2::{Sha256, Digest};
use anyhow::{Error, Result};

fn get_cli_binary_name() -> String {
    #[cfg(target_os = "android")]
    {
        let mut hasher = Sha256::new();
        hasher.update(crate::services::capture::get_ecapture_bytes());
        let hash_string = hex::encode(hasher.finalize());
        return format!("android_ecapture_arm64_{}", hash_string);
    }

    #[cfg(target_os = "linux")]
    {
        let mut hasher = Sha256::new();
        hasher.update(get_ecapture_bytes());
        let hash_string = hex::encode(hasher.finalize());
        return format!("linux_ecapture_amd64_{}", hash_string);
    }

    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    {
        panic!("Unsupported target OS");
    }
}

fn get_ecapture_bytes() -> &'static [u8] {
    #[cfg(target_os = "android")]
    {
        return include_bytes!("./../../binaries/android_test-aarch64-linux-android");
    }

    #[cfg(target_os = "linux")]
    {
        return include_bytes!("./../../binaries/linux_ecapture_test");
    }

    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    {
        panic!("Unsupported target OS");
    }
}

/// 负责管理 eCapture 子进程的整个生命周期
pub struct CaptureManager {
    executable_path: PathBuf,
    #[cfg(any(target_os = "android", target_os = "linux"))]
    child: Option<Child>,
    shutdown_tx: Option<watch::Sender<()>>,
}
impl CaptureManager {
    pub fn new(base_path: impl AsRef<Path>, shutdown_tx: watch::Sender<()>) -> Self {
        let executable_path = base_path.as_ref().join(get_cli_binary_name());
        Self {
            executable_path,
            #[cfg(any(target_os = "android", target_os = "linux"))]
            child: None,
            shutdown_tx: Some(shutdown_tx),
        }
    }

    #[cfg(target_os = "android")]
    fn prepare_binary(&self) -> Result<(), Box<dyn std::error::Error>> {
        if self.executable_path.exists() {
            // fs::remove_file(&self.executable_path)?;
            println!("found exist binary file");
            return Ok(())
        }

        let mut dest_file = fs::File::create(&self.executable_path)?;
        dest_file.write_all(get_ecapture_bytes())?;
        dest_file.sync_all()?; // 确保内容刷入磁盘

        let mut perms = fs::metadata(&self.executable_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&self.executable_path, perms)?;

        println!("eCapture binary prepared at: {:?}", self.executable_path);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn prepare_binary(&self) -> Result<()> {
        if self.executable_path.exists() {
            // fs::remove_file(&self.executable_path)?;
            println!("found exist binary file");
            return Ok(())
        }

        let mut dest_file = fs::File::create(&self.executable_path)?;
        dest_file.write_all(get_ecapture_bytes())?;
        dest_file.sync_all()?; // 确保内容刷入磁盘

        let mut perms = fs::metadata(&self.executable_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&self.executable_path, perms)?;

        println!("eCapture binary prepared at: {:?}", self.executable_path);
        Ok(())
    }

    #[cfg(any(target_os = "android", target_os = "linux"))]
    fn cleanup(&self) -> std::io::Result<()> {
        println!("Cleaning up eCapture binary...");
        fs::remove_file(&self.executable_path)
    }

    #[cfg(target_os = "android")]
    pub async fn run(
        &mut self,
        mut shutdown_rx: watch::Receiver<()>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.prepare_binary()?;

        let binary_command = self.executable_path.to_string_lossy().to_string();
        let full_command = format!("{} tls --ecaptureq ws://192.168.71.123:28257", binary_command);
        let mut child = Command::new("su") // 使用 tokio::process::Command
            .arg("-c")
            .arg(&full_command)
            .stdout(Stdio::null()) // 重定向输出
            .stderr(Stdio::null())
            .spawn()?;

        println!("eCapture process spawned with PID: {:?}", child.id());
        self.child = Some(child); // 将 child 存入 struct

        tokio::select! {
            biased;

            _ = shutdown_rx.changed() => {

                if let Some(child) = self.child.as_mut() {
                    let pid = child.id().ok_or("Failed to get child PID")?;

                    // 在 Android 上, 使用 `su -c kill`
                    println!("Running on Android, using 'su -c kill'...");
                    let kill_command = "pkill android_test";
                    let status = Command::new("su")
                        .arg("-c")
                        .arg(&kill_command)
                        .status()
                        .await?;

                    if status.success() {
                        println!("'su -c kill {}' command sent successfully.", pid);
                    } else {
                        eprintln!("'su -c kill {}' command failed with status: {}", pid, status);
                    }


                    tokio::select! {
                        result = child.wait() => {
                            println!("eCapture process exited gracefully with result: {:?}", result);
                        }
                        _ = tokio::time::sleep(Duration::from_secs(3)) => {
                            eprintln!("Process did not exit gracefully after 5s. Forcing kill...");
                            self.child.as_mut().unwrap().kill().await?;
                        }
                    }
                }
            }

            result = self.child.as_mut().unwrap().wait() => {
                match result {
                    Ok(status) => eprintln!("eCapture process exited unexpectedly with status: {}", status),
                    Err(e) => eprintln!("Error waiting for eCapture process: {}", e),
                }
            }
        }

        // self.cleanup()?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub async fn run(
        &mut self,
        mut shutdown_rx: watch::Receiver<()>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.prepare_binary()?;
        let binary_command = self.executable_path.to_string_lossy().to_string();
        let child = Command::new("sudo") // 使用 sudo 运行 eCapture
            .arg(&binary_command)
            .args(["tls", "--ecaptureq", "ws://127.0.0.1:18088"])
            .stdout(Stdio::null()) // 重定向输出
            .stderr(Stdio::null())
            .spawn()?;

        println!("eCapture process spawned with PID: {:?}", child.id());
        self.child = Some(child); // 将 child 存入 struct

        tokio::select! {
            biased;

            _ = shutdown_rx.changed() => {

                if let Some(child) = self.child.as_mut() {
                    let pid = child.id().ok_or("Failed to get child PID")?;

                    send_signal(Pid::from_raw(pid as i32), Signal::SIGINT)?;

                    tokio::select! {
                        result = child.wait() => {
                            println!("eCapture process exited gracefully with result: {:?}", result);
                        }
                        _ = tokio::time::sleep(Duration::from_secs(1)) => {
                            eprintln!("Process did not exit gracefully after 1s. Forcing kill...");
                            self.child.as_mut().unwrap().kill().await?;
                        }
                    }
                }
            }

            result = self.child.as_mut().unwrap().wait() => {
                match result {
                    Ok(status) => eprintln!("eCapture process exited unexpectedly with status: {}", status),
                    Err(e) => eprintln!("Error waiting for eCapture process: {}", e),
                }
            }
        }

        // self.cleanup()?;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
impl Drop for CaptureManager {
    // new*
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if let Some(pid) = child.id() {
                if let Err(_e) = send_signal(Pid::from_raw(pid as i32), Signal::SIGINT) {
                    eprintln!("Can not kill ecapture in drop trait");
                    return
                }
                println!("killed ecapture in drop trait")
            }
            println!("ecapture was killed, nothing to do")
        }
    }
}
