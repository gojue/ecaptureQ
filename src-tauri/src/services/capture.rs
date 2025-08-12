use anyhow::{Error, Result, anyhow};
use log::{error, info};
#[cfg(target_os = "linux")]
use nix::sys::signal::{Signal, kill as send_signal};
#[cfg(target_os = "linux")]
use nix::unistd::Pid;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command}; // Use Tokio's Command and Child
use tokio::sync::watch;

fn get_cli_binary_name() -> String {
    #[cfg(target_os = "android")]
    {
        let mut hasher = Sha256::new();
        hasher.update(crate::services::capture::get_ecapture_bytes());
        let hash_string = hex::encode(hasher.finalize());
        return format!("android_ecapture_arm64_{}", hash_string);
    }

    #[cfg(all(target_os = "linux", not(decoupled)))]
    {
        let mut hasher = Sha256::new();
        hasher.update(get_ecapture_bytes());
        let hash_string = hex::encode(hasher.finalize());
        return format!("linux_ecapture_amd64_{}", hash_string);
    }

    #[cfg(decoupled)]
    {
        return "ecapture".to_string();
    }

    // Default fallback for other platforms
    #[cfg(not(any(target_os = "android", target_os = "linux", decoupled)))]
    {
        "ecapture".to_string()
    }
}

fn get_ecapture_bytes() -> &'static [u8] {
    // Android x86_64
    #[cfg(all(target_os = "android", target_arch = "x86_64"))]
    {
        return include_bytes!("../../binaries/android_ecapture_x86_64");
    }

    // Android arm64
    #[cfg(all(target_os = "android", target_arch = "aarch64"))]
    {
        return include_bytes!("../../binaries/android_ecapture_arm64");
    }

    // Linux x86_64
    #[cfg(all(target_os = "linux", target_arch = "x86_64", not(decoupled)))]
    {
        return include_bytes!("../../binaries/linux_ecapture_x86_64");
    }

    // Linux arm64
    #[cfg(all(target_os = "linux", target_arch = "aarch64", not(decoupled)))]
    {
        return include_bytes!("../../binaries/linux_ecapture_arm64");
    }

    #[cfg(any(all(not(target_os = "linux"), not(target_os = "android")), decoupled))]
    {
        panic!("Unsupported platform or architecture");
    }
}
pub struct CaptureManager {
    executable_path: PathBuf,
    child: Option<Child>,
}

impl CaptureManager {
    pub fn new(base_path: impl AsRef<Path>) -> Self {
        let executable_path = base_path.as_ref().join(get_cli_binary_name());
        Self {
            executable_path,
            child: None,
        }
    }

    #[cfg(target_os = "android")]
    fn prepare_binary(&self) -> Result<(), Box<dyn std::error::Error>> {
        if self.executable_path.exists() {
            // fs::remove_file(&self.executable_path)?;
            info!("Found existing binary file");
            return Ok(());
        }

        let mut dest_file = fs::File::create(&self.executable_path)?;
        dest_file.write_all(get_ecapture_bytes())?;
        dest_file.sync_all()?; // Ensure content is flushed to disk

        let mut perms = fs::metadata(&self.executable_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&self.executable_path, perms)?;

        info!("eCapture binary prepared at: {:?}", self.executable_path);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn prepare_binary(&self) -> Result<()> {
        if self.executable_path.exists() {
            // fs::remove_file(&self.executable_path)?;
            info!("Found existing binary file");
            return Ok(());
        }

        let mut dest_file = fs::File::create(&self.executable_path)?;
        dest_file.write_all(get_ecapture_bytes())?;
        dest_file.sync_all()?; // Ensure content is flushed to disk

        let mut perms = fs::metadata(&self.executable_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&self.executable_path, perms)?;

        info!("eCapture binary prepared at: {:?}", self.executable_path);
        Ok(())
    }

    #[cfg(any(target_os = "android", target_os = "linux"))]
    fn cleanup(&self) -> std::io::Result<()> {
        info!("Cleaning up eCapture binary...");
        fs::remove_file(&self.executable_path)
    }

    #[cfg(target_os = "android")]
    pub async fn run(
        &mut self,
        mut shutdown_rx: watch::Receiver<()>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.prepare_binary()?;

        let binary_command = self.executable_path.to_string_lossy().to_string();
        let full_command = format!(
            "{} tls --ecaptureq ws://192.168.71.123:28257",
            binary_command
        );
        let mut child = Command::new("su") // 使用 tokio::process::Command
            .arg("-c")
            .arg(&full_command)
            .stdout(Stdio::null()) // 重定向输出
            .stderr(Stdio::null())
            .spawn()?;

        info!("eCapture process spawned with PID: {:?}", child.id());
        self.child = Some(child); // 将 child 存入 struct

        tokio::select! {
            biased;

            _ = shutdown_rx.changed() => {

                if let Some(child) = self.child.as_mut() {
                    let pid = child.id().ok_or("Failed to get child PID")?;

                    // 在 Android 上, 使用 `su -c kill`
                    info!("Running on Android, using 'su -c kill'...");
                    let kill_command = "pkill android_test";
                    let status = Command::new("su")
                        .arg("-c")
                        .arg(&kill_command)
                        .status()
                        .await?;

                    if status.success() {
                        info!("'su -c kill {}' command sent successfully.", pid);
                    } else {
                        error!("'su -c kill {}' command failed with status: {}", pid, status);
                    }


                    tokio::select! {
                        result = child.wait() => {
                            info!("eCapture process exited gracefully with result: {:?}", result);
                        }
                        _ = tokio::time::sleep(Duration::from_secs(3)) => {
                            error!("Process did not exit gracefully after 5s. Forcing kill...");
                            self.child.as_mut().unwrap().kill().await?;
                        }
                    }
                }
            }

            result = self.child.as_mut().unwrap().wait() => {
                match result {
                    Ok(status) => error!("eCapture process exited unexpectedly with status: {}", status),
                    Err(e) => error!("Error waiting for eCapture process: {}", e),
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
        ecapture_args: String,
    ) -> Result<()> {
        self.prepare_binary()?;
        let binary_command = self.executable_path.to_string_lossy().to_string();
        let args_vec: Vec<&str> = ecapture_args.split_whitespace().collect();
        let child = Command::new(&binary_command)
            .args(args_vec)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;

        info!("eCapture process spawned with PID: {:?}", child.id());
        self.child = Some(child); // 将 child 存入 struct

        tokio::select! {
            biased;

            _ = shutdown_rx.changed() => {

                if let Some(child) = self.child.as_mut() {
                    let pid = child.id().ok_or_else(|| anyhow!("can not get child pid"))?;

                    send_signal(Pid::from_raw(pid as i32), Signal::SIGINT)?;

                    tokio::select! {
                        result = child.wait() => {
                            info!("eCapture process exited gracefully with result: {:?}", result);
                        }
                        _ = tokio::time::sleep(Duration::from_secs(1)) => {
                            error!("Process did not exit gracefully after 1s. Forcing kill...");
                            self.child.as_mut().unwrap().kill().await?;
                        }
                    }
                }
            }

            result = self.child.as_mut().unwrap().wait() => {
                match result {
                    Ok(status) => error!("eCapture process exited unexpectedly with status: {}", status),
                    Err(e) => error!("Error waiting for eCapture process: {}", e),
                }
                return Err(anyhow!("ecapture failed launch"))
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
                    error!("Can not kill ecapture in drop trait");
                    return;
                }
                info!("killed ecapture in drop trait")
            }
            info!("ecapture was killed, nothing to do")
        }
    }
}
