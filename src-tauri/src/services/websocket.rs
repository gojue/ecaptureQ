use anyhow::Result;
use std::sync::Arc;

use futures_util::stream::StreamExt;
use log::{info, error};
use tokio::sync::{RwLock, watch};
use tokio::time::{Duration, sleep};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig},
};

use crate::core::{
    actor,
    data_processing::parse_eq_message,
    models::{HeartbeatMessage, PacketData, ParsedMessage, ProcessLogMessage},
};
use crate::tauri_bridge::state::RunState;

pub struct WebsocketService {
    ws_url: String,
    df_handle: actor::DataFrameActorHandle,
    done: watch::Receiver<()>,
    run_status: Arc<RwLock<RunState>>,
}

const BATCH_SIZE: usize = 20;
const FLUSH_TIMEOUT: Duration = Duration::from_millis(300);

impl WebsocketService {
    pub fn new(
        ws_url: String,
        df_handle: actor::DataFrameActorHandle,
        done: watch::Receiver<()>,
        run_status: Arc<RwLock<RunState>>,
    ) -> Result<Self> {
        Ok(Self {
            ws_url,
            df_handle,
            done,
            run_status,
        })
    }

    pub async fn receiver_task(&mut self) -> Result<()> {
        log::info!("Attempting WebSocket connection to: {}", self.ws_url);

        let mut request = self.ws_url.as_str().into_client_request()?;

        request
            .headers_mut()
            .insert("Origin", HeaderValue::from_static("http://localhost/"));

        let config = WebSocketConfig::default();
        let (ws_stream, _) = connect_async_with_config(request, Some(config), false).await?;
        log::info!("WebSocket connected");

        let mut buffer: Vec<PacketData> = Vec::with_capacity(BATCH_SIZE);
        let mut flush_timer = tokio::time::interval(FLUSH_TIMEOUT);

        // Store other message types (print for now, can process later)
        let mut heartbeat_messages: Vec<HeartbeatMessage> = Vec::new();
        let mut log_messages: Vec<ProcessLogMessage> = Vec::new();

        let (_, mut read) = ws_stream.split();

        loop {
            tokio::select! {
                biased;

                _ = self.done.changed() => {
                    info!("Websocket service shutting down");
                    break;
                }

                _ = flush_timer.tick() => {
                if !buffer.is_empty() {
                    self.df_handle.update_batch(std::mem::take(&mut buffer)).await;
                }
            }

                Some(message) = read.next() => {
                    let msg = match message {
                        Ok(msg) => msg,
                        Err(e) => {
                            error!("WebSocket message error: {:?}", e);
                            match self.run_status.read().await.clone() {
                                RunState::Capturing => {
                                    sleep(Duration::from_millis(300)).await;
                                }
                                _ => {
                                    break;
                                }
                            }
                            break;
                        }
                    };

                    if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                        match parse_eq_message(&text) {
                            Ok(parsed_message) => {
                                match parsed_message {
                                    ParsedMessage::Event(packet_data) => {
                                        buffer.push(packet_data);
                                    }
                                    ParsedMessage::Heartbeat(heartbeat) => {
                                        // println!("Heartbeat: {:?}", heartbeat);
                                        heartbeat_messages.push(heartbeat);
                                    }
                                    ParsedMessage::ProcessLog(log) => {
                                        // println!("Log: level={:?}, message={:?}, time={:?}, info={}",
                                        //     log.level, log.message, log.time, log.log_info);
                                        log_messages.push(log);
                                    }
                                }
                            }
                            Err(e) => {
                                log::error!("Parse message failed: {:?}, raw: {}", e, text);
                                // Don't terminate connection on single message parse failure
                                continue;
                            }
                        }
                    }

                    if buffer.len() >= BATCH_SIZE {
                        self.df_handle.update_batch(std::mem::take(&mut buffer)).await;
                        flush_timer.reset();
                    }
                }
            }
        }

        log::info!("WebSocket receiver task closed");
        Ok(())
    }
}
