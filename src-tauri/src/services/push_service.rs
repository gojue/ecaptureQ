use crate::core::actor::DataFrameActorHandle;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, watch};

#[derive(Clone)]
pub struct PushServiceHandle {
    sql_string: Arc<Mutex<String>>,
    offset: Arc<Mutex<usize>>,
}

impl PushServiceHandle {
    pub async fn change_query(&self, sql_string: String) {
        let mut sql_str = self.sql_string.lock().await;
        *sql_str = sql_string;
        self.reset_offset().await;
    }

    pub async fn reset_offset(&self) {
        let mut offset = self.offset.lock().await;
        *offset = 0;
        println!("Offset has been reset to 0.");
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
            offset: Arc::new(Mutex::new(0)),
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
        println!("Push service started.");

        loop {
            tokio::select! {
                biased;

                _ = self.done.changed() => {
                    println!("Push service shutting down");
                    break;
                }

                _ = flush_timer.tick() => {
                    let mut offset = self.handle.offset.lock().await;
                    let current_offset = *offset;

                    let new_df_result = self.df_actor_handle
                        .get_packets_by_offset(current_offset)
                        .await;

                    if let Ok(new_df) = new_df_result {
                        let new_rows_count = new_df.height();
                        if new_rows_count > 0 {
                            // update offset
                            *offset += new_rows_count;
                            println!("Fetched {} new rows. New offset: {}", new_rows_count, *offset);
                            if let Ok(vecs) = crate::tauri_bridge::converters::df_to_packet_data_vec(&new_df).map_err(|e| e.to_string()) {
                                if let Err(e) = self.app_handle.emit(self.tauri_interface.as_str(), &vecs) {
                                    eprintln!("Failed to send log to frontend: {}", e);
                                }
                            }
                        }
                    } else if let Err(e) = new_df_result {
                        eprintln!("Error fetching packets: {}", e.to_string());
                    }
                }
            }
        }
    }
}
