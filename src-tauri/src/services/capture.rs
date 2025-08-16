use std::collections::HashSet;
use anyhow::{Error, Result, anyhow};
use log::{error, info};
#[cfg(not(target_os = "windows"))]
use nix::sys::signal::{Signal, kill as send_signal};
#[cfg(not(target_os = "windows"))]
use nix::unistd::Pid;
use sha2::{Digest, Sha256};
use std::{fs, process};
use std::io::Write;
#[cfg(not(target_os = "windows"))]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use futures_util::future;
use tokio::process::{Child, Command}; // Use Tokio's Command and Child
use tokio::sync::watch;

fn get_cli_binary_name() -> String {
    // Android x86_64
    #[cfg(all(target_os = "android", target_arch = "x86_64"))]
    {
        let mut hasher = Sha256::new();
        hasher.update(get_ecapture_bytes());
        let hash_string = hex::encode(hasher.finalize());
        return format!("android_ecapture_amd64_{}", hash_string);
    }

    // Android arm64
    #[cfg(all(target_os = "android", target_arch = "aarch64"))]
    {
        let mut hasher = Sha256::new();
        hasher.update(get_ecapture_bytes());
        let hash_string = hex::encode(hasher.finalize());
        return format!("android_ecapture_arm64_{}", hash_string);
    }

    // Linux x86_64
    #[cfg(all(target_os = "linux", target_arch = "x86_64", not(decoupled)))]
    {
        let mut hasher = Sha256::new();
        hasher.update(get_ecapture_bytes());
        let hash_string = hex::encode(hasher.finalize());
        return format!("linux_ecapture_amd64_{}", hash_string);
    }

    // Linux arm64
    #[cfg(all(target_os = "linux", target_arch = "aarch64", not(decoupled)))]
    {
        let mut hasher = Sha256::new();
        hasher.update(get_ecapture_bytes());
        let hash_string = hex::encode(hasher.finalize());
        return format!("linux_ecapture_arm64_{}", hash_string);
    }

    "ecapture".to_string()
}

// Android x86_64
#[cfg(all(target_os = "android", target_arch = "x86_64"))]
fn get_ecapture_bytes() -> &'static [u8] {
    include_bytes!("../../binaries/android_ecapture_amd64")
}

// Android arm64
#[cfg(all(target_os = "android", target_arch = "aarch64"))]
fn get_ecapture_bytes() -> &'static [u8] {
    include_bytes!("../../binaries/android_ecapture_arm64")
}

// Linux x86_64
#[cfg(all(target_os = "linux", target_arch = "x86_64", not(decoupled)))]
fn get_ecapture_bytes() -> &'static [u8] {
    include_bytes!("../../binaries/linux_ecapture_amd64")
}

// Linux arm64
#[cfg(all(target_os = "linux", target_arch = "aarch64", not(decoupled)))]
fn get_ecapture_bytes() -> &'static [u8] {
    include_bytes!("../../binaries/linux_ecapture_arm64")
}

// Fallback for unsupported platforms.
#[cfg(any(all(not(target_os = "linux"), not(target_os = "android")), decoupled))]
fn get_ecapture_bytes() -> &'static [u8] {
    panic!("Unsupported platform or architecture");
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
    fn prepare_binary(&self) -> Result<()> {
        if self.executable_path.exists() {
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
        ecapture_args: String,
    ) -> Result<()> {
        // --- 1. Initial Cleanup ---
        // Clean up any orphaned processes from previous runs.
        let cleaner = AndroidCleaner::new();
        let cleanup_targets = ["android_ecapture"];
        let cleanup_exempt_names = ["com.gojue.ecaptureq"];
        let mut exempt_pids = HashSet::new();
        exempt_pids.insert(process::id()); // Always exempt the main app process itself.

        info!("Running initial cleanup before starting process...");
        if let Err(e) = cleaner
            .cleanup_processes(&cleanup_targets, &exempt_pids, &cleanup_exempt_names)
            .await
        {
            error!("Initial cleanup failed, continuing anyway: {}", e);
        }

        self.prepare_binary()?;

        let binary_command = self.executable_path.to_string_lossy().to_string();
        let args_vec: Vec<&str> = ecapture_args.split_whitespace().collect();
        let mut child = Command::new("su")
            .arg("-c")
            .arg(&binary_command)
            .args(&args_vec)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;

        info!("eCapture process started via 'su -c'.");
        self.child = Some(child);

        // --- Main event loop ---
        tokio::select! {
        biased;

        // Branch for graceful shutdown
        _ = shutdown_rx.changed() => {
            info!("Shutdown signal received, cleaning up eCapture process(es)...");

            if let Err(e) = cleaner
                .cleanup_processes(&cleanup_targets, &exempt_pids, &cleanup_exempt_names)
                .await
            {
                error!("Cleanup on shutdown signal failed: {}", e);
            } else {
                info!("Cleanup on shutdown signal completed.");
            }

            // The process should be terminated by the cleaner, so we can now drop the child handle.
            self.child.take();
        }

        // Branch for unexpected process exit
        result = self.child.as_mut().unwrap().wait() => {
            match result {
                Ok(status) => error!("eCapture process exited unexpectedly with status: {}", status),
                Err(e) => error!("Error waiting for eCapture process: {}", e),
            }
            return Err(anyhow!("eCapture process exited unexpectedly"));
        }
    }

        // This part is reached after a graceful shutdown.
        // It is slightly redundant but acts as a final safety net to ensure a clean state.
        info!("Running final cleanup before exiting...");
        if let Err(e) = cleaner
            .cleanup_processes(&cleanup_targets, &exempt_pids, &cleanup_exempt_names)
            .await
        {
            error!("Final cleanup failed: {}", e);
        }

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

#[cfg(target_os = "android")]
pub struct AndroidCleaner;

#[cfg(target_os = "android")]
impl AndroidCleaner {
    /// Creates a new cleaner instance.
    pub fn new() -> Self {
        AndroidCleaner
    }

    pub async fn cleanup_processes(
        &self,
        targets: &[&str],
        exempt_pids: &HashSet<u32>,
        exempt_names: &[&str],
    ) -> Result<()> {
        info!("Starting Android process cleanup for targets: {:?}", targets);

        let find_futures = targets
            .iter()
            .map(|name| self.find_pids_by_name(name, exempt_names));
        let find_results = future::join_all(find_futures).await;

        let mut pids_to_kill = HashSet::new();
        for result in find_results {
            match result {
                Ok(pids) => {
                    for pid in pids {
                        if !exempt_pids.contains(&pid) {
                            pids_to_kill.insert(pid);
                        }
                    }
                }
                Err(e) => error!("Error finding processes during cleanup: {}", e),
            }
        }

        if pids_to_kill.is_empty() {
            info!("No orphaned processes found to clean up.");
            return Ok(());
        }

        info!("Found processes to kill: {:?}", pids_to_kill);

        let kill_futures = pids_to_kill.iter().map(|&pid| self.kill_process(pid));
        let kill_results = future::join_all(kill_futures).await;

        let killed_count = kill_results.into_iter().filter(|res| res.is_ok()).count();
        info!(
            "Cleanup finished. Attempted to kill {} processes, {} succeeded.",
            pids_to_kill.len(),
            killed_count
        );

        Ok(())
    }

    /// Finds PIDs by searching the full command line arguments.
    async fn find_pids_by_name(
        &self,
        keyword: &str,
        exempt_names: &[&str],
    ) -> Result<Vec<u32>> {
        let ps_command = "ps -A -o PID,ARGS";

        // Execute the `ps` command as root to see all processes.
        let output = Command::new("su")
            .arg("-c")
            .arg(ps_command)
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("Root `ps` command failed with status: {}. Stderr: {}", output.status, stderr);
            return Err(anyhow!("Failed to execute 'ps' as root"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut pids = Vec::new();

        for line in stdout.lines().skip(1) { // Skip header
            let trimmed_line = line.trim();
            // Split into PID and the rest of the line (ARGS)
            let parts: Vec<&str> = trimmed_line.splitn(2, char::is_whitespace).collect();

            if parts.len() == 2 {
                let pid_str = parts[0];
                let full_args = parts[1];

                let is_self_ps_command = full_args.contains(ps_command);

                if full_args.contains(keyword) && !is_self_ps_command {
                    let is_exempted_by_name = exempt_names.iter().any(|&name| full_args.contains(name));

                    if !is_exempted_by_name {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            pids.push(pid);
                        }
                    }
                }
            }
        }
        Ok(pids)
    }

    /// Kills the specified process by PID using `su`.
    async fn kill_process(&self, pid: u32) -> Result<()> {
        let status = Command::new("su")
            .arg("-c")
            .arg(format!("kill -9 {}", pid))
            .status()
            .await?;

        if status.success() {
            info!("Successfully terminated process with PID: {}", pid);
            Ok(())
        } else {
            error!("Failed to kill process with PID: {}. It might have already exited.", pid);
            Err(anyhow!("Failed to kill PID: {}", pid))
        }
    }
}