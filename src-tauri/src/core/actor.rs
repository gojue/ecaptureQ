use crate::core::data_processing;
use crate::core::models;
use polars::prelude::*;
use polars::sql::SQLContext;
use tokio::sync::{mpsc, oneshot, watch};

type Responder<T> = oneshot::Sender<T>;

#[derive(Debug)]
pub enum ActorMessage {
    UpdateBatch(Vec<models::PacketData>),

    QuerySql {
        sql: String,
        resp: Responder<PolarsResult<DataFrame>>,
    },
}

enum ActorEvent {
    Message(ActorMessage),
    Shutdown,
}

#[derive(Clone)]
pub struct DataFrameActorHandle {
    pub sender: mpsc::Sender<ActorMessage>,
    pub done: watch::Sender<()>,
}

impl DataFrameActorHandle {
    pub async fn update_batch(&self, batch: Vec<models::PacketData>) {
        let _ = self.sender.send(ActorMessage::UpdateBatch(batch)).await;
    }

    pub async fn query_sql(&self, sql: String) -> Result<DataFrame, Box<dyn std::error::Error>> {
        let (send_one, recv_one) = oneshot::channel();
        self.sender
            .send(ActorMessage::QuerySql {
                sql,
                resp: send_one,
            })
            .await?;
        Ok(recv_one.await??)
    }

    pub fn close(&self) {
        let _ = self.done.send(());
    }
}

pub struct DataFrameActor {
    receiver: mpsc::Receiver<ActorMessage>,
    df: DataFrame,
    ctx: SQLContext,
    done: watch::Receiver<()>,
}

impl DataFrameActor {
    pub fn new(
        receiver: mpsc::Receiver<ActorMessage>,
        done: watch::Receiver<()>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let df = create_capture_df();
        let mut ctx = SQLContext::new();
        ctx.register("lazy", df.clone().lazy());
        Ok(Self {
            receiver,
            df,
            ctx,
            done,
        })
    }

    pub async fn run(self) -> Result<(), Box<dyn std::error::Error>> {
        let Self {
            mut receiver,
            mut df,
            mut ctx,
            mut done,
        } = self;

        loop {
            let event = tokio::select! {
            biased;

            _ = done.changed() => ActorEvent::Shutdown,
            Some(msg) = receiver.recv() => ActorEvent::Message(msg),

            else => {
                return Err("All channels closed".into());
            }
            };
            match event {
                ActorEvent::Message(msg) => match msg {
                    ActorMessage::UpdateBatch(batch) => {
                        data_processing::write_batch_to_df(&batch, &mut df)?;
                    }
                    ActorMessage::QuerySql { sql, resp } => {
                        ctx.unregister("packets");
                        ctx.register("packets", df.clone().lazy());
                        if resp.send(ctx.execute(&sql)?.collect()).is_err() {
                            eprintln!("Oneshot channel send failed");
                        }
                    }
                },

                ActorEvent::Shutdown => {
                    return Ok(());
                }
            }
        }
    }
}
fn create_capture_df() -> DataFrame {
    let schema = Schema::from_iter(vec![
        Field::new("timestamp".into(), DataType::Int64),
        Field::new("src_ip".into(), DataType::String),
        Field::new("src_port".into(), DataType::UInt32),
        Field::new("dst_ip".into(), DataType::String),
        Field::new("dst_port".into(), DataType::UInt32),
        Field::new("pid".into(), DataType::Int32),
        Field::new("pname".into(), DataType::String),
        Field::new("type".into(), DataType::String),
        Field::new("length".into(), DataType::UInt32),
        Field::new("payload_base64".into(), DataType::String),
    ]);

    DataFrame::empty_with_schema(&schema)
}
