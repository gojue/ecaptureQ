use crate::core::actor::DataFrameActorHandle;
use log::{error, info};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, watch};

#[derive(Clone)]
pub struct PushServiceHandle {
    sql_string: Arc<Mutex<String>>,
    last_index: Arc<Mutex<u64>>,
}

impl PushServiceHandle {
    pub async fn change_query(&self, sql_string: String) {
        let mut sql_str = self.sql_string.lock().await;
        *sql_str = sql_string;
        self.reset_offset().await;
    }

    pub async fn reset_offset(&self) {
        let mut last_index = self.last_index.lock().await;
        *last_index = 0;
        info!("Last index has been reset to 0.");
    }
}

pub struct PushService {
    df_actor_handle: DataFrameActorHandle,
    tauri_interface: String,
    handle: PushServiceHandle,
    done: watch::Receiver<()>,
    app_handle: AppHandle,
}

impl PushService {
    pub fn new(
        handle: DataFrameActorHandle,
        interface: String,
        sql_string: String,
        done: watch::Receiver<()>,
        app_handle: AppHandle,
    ) -> PushServiceHandle {
        let service_handle = PushServiceHandle {
            sql_string: Arc::new(Mutex::new(sql_string)),
            last_index: Arc::new(Mutex::new(0)),
        };

        // 创建 Worker 实例
        let mut worker = Self {
            df_actor_handle: handle,
            tauri_interface: interface,
            handle: service_handle.clone(),
            done,
            app_handle,
        };

        tokio::spawn(async move {
            worker.run().await;
        });

        service_handle
    }

    pub async fn run(&mut self) {
        let mut flush_timer = tokio::time::interval(Duration::from_millis(300));
        info!("Push service started.");

        loop {
            tokio::select! {
                biased;

                _ = self.done.changed() => {
                    info!("Push service shutting down");
                    break;
                }

                _ = flush_timer.tick() => {
                    let mut last_index_guard = self.handle.last_index.lock().await;
                    let current_last_index = *last_index_guard;

                    let new_df_result = self.df_actor_handle
                        .get_packets_since_index_no_payload(current_last_index)
                        .await;

                    if let Ok(new_df) = new_df_result {
                        if new_df.height() > 0 {
                            if let Ok(vecs) = crate::tauri_bridge::converters::df_to_packet_data_frontend_vec(&new_df).map_err(|e| e.to_string()) {
                                if !vecs.is_empty() {
                                    // Update last_index to the highest index from the fetched data
                                    if let Some(last_packet) = vecs.last() {
                                        *last_index_guard = last_packet.index;
                                        info!("Fetched {} new packets. New last_index: {}", vecs.len(), last_packet.index);
                                    }
                                    
                                    if let Err(e) = self.app_handle.emit(self.tauri_interface.as_str(), &vecs) {
                                        error!("Failed to send log to frontend: {}", e);
                                    }
                                }
                            }
                        }
                    } else if let Err(e) = new_df_result {
                        error!("Error fetching packets: {}", e.to_string());
                    }
                }
            }
        }
    }
}
