use crate::core::actor::DataFrameActorHandle;
use anyhow::Result;
use log::{error, info};
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter};
use tokio::sync::{watch, Mutex};

pub struct PushService {
    df_actor_handle: DataFrameActorHandle,
    tauri_interface: String,
    done: watch::Receiver<()>,
    user_sql: Option<String>,
    last_index: u64,
    app_handle: AppHandle,
    shared_last_index: Arc<Mutex<u64>>,
}

impl PushService {
    pub fn new(
        handle: DataFrameActorHandle,
        interface: String,
        user_sql: Option<String>,
        last_index: u64,
        shared_last_index: Arc<Mutex<u64>>,
        done: watch::Receiver<()>,
        app_handle: AppHandle,
    ) -> Result<()> {
        // 创建 Worker 实例
        let mut worker = Self {
            df_actor_handle: handle,
            tauri_interface: interface,
            done,
            app_handle,
            user_sql,
            last_index,
            shared_last_index,
        };

        tokio::spawn(async move {
            worker.run().await;
        });
        Ok(())
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

                    let new_df_result = match &self.user_sql {
                        Some(sql_str) => {
                            self.df_actor_handle.get_packets_customized_no_payload(&self.last_index, sql_str).await
                        }
                        None => {
                            self.df_actor_handle.get_packets_since_index_no_payload(&self.last_index).await
                        }
                    };

                    if let Ok(new_df) = new_df_result {
                        if new_df.height() > 0 {
                            if let Ok(vecs) = crate::tauri_bridge::converters::df_to_packet_data_frontend_vec(&new_df).map_err(|e| e.to_string()) {
                                if !vecs.is_empty() {
                                    // Update last_index to the highest index from the fetched data
                                    if let Some(last_packet) = vecs.last() {
                                        self.last_index = last_packet.index;
                                        let mut guard = self.shared_last_index.lock().await;
                                        *guard = self.last_index;
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
