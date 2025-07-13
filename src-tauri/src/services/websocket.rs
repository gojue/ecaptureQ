use crate::core::actor;
use crate::core::data_processing::parse_packet_data;
use crate::core::models::PacketData;
use futures_util::stream::StreamExt;
use tokio::sync::watch;

pub struct WebsocketService {
    ws_url: String,
    df_handle: actor::DataFrameActorHandle,
    done: watch::Receiver<()>,
}

impl WebsocketService {
    pub fn new(
        ws_url: String,
        df_handle: actor::DataFrameActorHandle,
        done: watch::Receiver<()>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            ws_url,
            df_handle,
            done,
        })
    }

    async fn receiver_task(&self) -> Result<(), Box<dyn std::error::Error>> {
        let (ws_stream, _) = tokio_tungstenite::connect_async(self.ws_url.clone()).await?;

        let (_, mut read) = ws_stream.split();

        while let Some(message) = read.next().await {
            let msg = match message {
                Ok(msg) => msg,
                Err(e) => {
                    eprintln!("接收WebSocket消息时出错: {:?}", e);
                    continue;
                }
            };

            if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                match parse_packet_data(&text) {
                    Ok(parsed_data) => self.df_handle.update_batch(vec![parsed_data]).await,
                    Err(e) => {
                        return Err(e.into());
                    }
                }
            }
        }
        Ok(())
    }
}
