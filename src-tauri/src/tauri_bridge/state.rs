use crate::core::actor::DataFrameActorHandle;
use tokio::sync::Mutex;
use tokio::sync::watch;
use tokio::task::JoinHandle;

pub struct CaptureSessionHandles {
    pub capture_manager_handle: JoinHandle<()>,
    pub websocket_service_handle: JoinHandle<()>,
}

pub struct AppState {
    pub df_actor_handle: DataFrameActorHandle,
    pub shutdown_tx: Mutex<Option<watch::Sender<()>>>,
    pub session_handles: Mutex<Option<CaptureSessionHandles>>,

    // track frontend pull offset
    pub offset: Mutex<usize>,
}
