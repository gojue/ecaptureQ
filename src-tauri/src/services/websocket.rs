use crate::core::actor;
use crate::core::data_processing::parse_packet_data;
use crate::core::models::PacketData;
use futures_util::stream::StreamExt;
use std::time::Duration;
use tokio::sync::watch;

pub struct WebsocketService {
    ws_url: String,
    df_handle: actor::DataFrameActorHandle,
    done: watch::Receiver<()>,
}

const BATCH_SIZE: usize = 20;
const FLUSH_TIMEOUT: Duration = Duration::from_millis(300);

impl WebsocketService {
    pub fn new(
        ws_url: String,
        df_handle: actor::DataFrameActorHandle,
        done: watch::Receiver<()>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut buffer: Vec<PacketData> = Vec::with_capacity(BATCH_SIZE);
        Ok(Self {
            ws_url,
            df_handle,
            done,
        })
    }

    async fn receiver_task(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let (ws_stream, _) = tokio_tungstenite::connect_async(&self.ws_url).await?;
        println!("WebSocket 连接成功");

        let mut buffer: Vec<PacketData> = Vec::with_capacity(BATCH_SIZE);
        let mut flush_timer = tokio::time::interval(FLUSH_TIMEOUT);

        let (_, mut read) = ws_stream.split();

        loop {
            tokio::select! {
                biased;

                _ = self.done.changed() => {
                    println!("{}", "Websocket service shutting down");
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
                            eprintln!("接收WebSocket消息时出错: {:?}", e);
                            break;
                        }
                    };

                    if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                        match parse_packet_data(&text) {
                            Ok(parsed_data) => { buffer.push(parsed_data); }
                            Err(e) => {
                                eprintln!("error parsing packet {:?}", e);
                                return Err(e.into());
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

        println!("WebSocket 接收任务已关闭");
        Ok(())
    }
}
