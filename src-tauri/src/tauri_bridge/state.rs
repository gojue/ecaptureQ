use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock, watch};

use crate::core::actor::DataFrameActorHandle;

use anyhow::{Error, Result};
// use log::Level::Error;

#[derive(Clone)]
pub enum RunState {
    NotCapturing,
    Capturing,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Configs {
    pub ws_url: Option<String>,
    pub ecapture_args: Option<String>,
    #[serde(default)]
    pub user_sql: Option<String>,
}

const CONFIG_FILE_NAME: &str = "config.json";

impl Configs {
    pub fn apply_patch(&mut self, patch: &mut Configs) {
        if let Some(ws_url) = patch.ws_url.take() {
            self.ws_url = Some(ws_url);
        }

        if let Some(ecapture_args) = patch.ecapture_args.take() {
            self.ecapture_args = Some(ecapture_args);
        }

        if patch.user_sql.is_some() {
            self.user_sql = patch.user_sql.take();
        }
    }

    fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }

    fn from_json(json_str: &str) -> serde_json::Result<Self> {
        serde_json::from_str(json_str)
    }

    pub fn get_json_from_app_dir(base_path: impl AsRef<Path>) -> Result<Self> {
        let json_data = fs::read_to_string(base_path.as_ref().join(CONFIG_FILE_NAME))?;
        let configs = Self::from_json(json_data.as_str())?;
        Ok(configs)
    }

    pub fn save_json_to_app_dir(&self, base_path: impl AsRef<Path>) -> Result<()> {
        let path = base_path.as_ref().join(CONFIG_FILE_NAME);
        let json_data = self.to_json()?;
        fs::write(path, json_data).map_err(Error::from)
    }

    pub fn init() -> Self {
        Configs {
            ws_url: Some("ws://127.0.0.1:28257".to_string()),
            ecapture_args: Some(" tls --ecaptureq ws://127.0.0.1:28257".to_string()),
            user_sql: None,
        }
    }
}

pub fn config_check(base_path: impl AsRef<Path>) -> Result<()> {
    if base_path.as_ref().join(CONFIG_FILE_NAME).exists() {
        if let Ok(_) = Configs::get_json_from_app_dir(&base_path) {
            Ok(())
        } else {
            Configs::init().save_json_to_app_dir(&base_path)?;
            Ok(())
        }
    } else {
        Configs::init().save_json_to_app_dir(&base_path)?;
        Ok(())
    }
}

pub struct AppState {
    pub df_actor_handle: DataFrameActorHandle,
    pub shutdown_tx: Mutex<Option<watch::Sender<()>>>,

    // will trigger if the whole app shutdown
    pub done: Mutex<watch::Sender<()>>,

    // runtime configs
    pub configs: Mutex<Option<Configs>>,

    // user-provided SQL for push service
    pub user_sql: Mutex<Option<String>>,

    // shared last index across services
    pub shared_last_index: Arc<Mutex<u64>>,

    pub status: Arc<RwLock<RunState>>,
}

impl AppState {
    pub async fn init_configs(&self, configs: Configs) {
        {
            let mut configs_lock = self.configs.lock().await;
            *configs_lock = Some(configs.clone());
        }
        let mut user_sql_lock = self.user_sql.lock().await;
        *user_sql_lock = configs.user_sql.clone();
    }
}
