use crate::core::actor::DataFrameActorHandle;
use crate::services::push_service::PushServiceHandle;
use tokio::sync::Mutex;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use serde::{Deserialize, Serialize};

pub struct CaptureSessionHandles {
    pub websocket_service_handle: JoinHandle<()>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Configs {
    pub ws_url: Option<String>,
    pub ecapture_args: Option<String>,
}

impl Configs {
    pub fn apply_patch(&mut self, patch: Configs) {
        if let Some(ws_url) = patch.ws_url {
            self.ws_url = Some(ws_url);
        }

        if let Some(ecapture_args) = patch.ecapture_args {
            self.ecapture_args = Some(ecapture_args);
        }
    }
}




pub struct AppState {
    pub push_service_handle: Mutex<Option<PushServiceHandle>>,
    pub df_actor_handle: DataFrameActorHandle,
    pub shutdown_tx: Mutex<Option<watch::Sender<()>>>,
    pub session_handles: Mutex<Option<CaptureSessionHandles>>,

    // will trigger if the whole app shutdown
    pub done: Mutex<watch::Sender<()>>,

    // runtime configs
    pub configs: Mutex<Configs>
}
