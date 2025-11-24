use crate::core::data_processing;
use crate::core::models;
use crate::core::queries;
use anyhow::{Result, anyhow};
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

    pub async fn query_sql(&self, sql: String) -> PolarsResult<DataFrame> {
        let (send_one, recv_one) = oneshot::channel();
        self.sender
            .send(ActorMessage::QuerySql {
                sql,
                resp: send_one,
            })
            .await
            .map_err(|e| PolarsError::ComputeError(e.to_string().into()))?;

        recv_one
            .await
            .map_err(|e| PolarsError::ComputeError(e.to_string().into()))?
    }

    pub async fn get_packets_since_index_no_payload(
        &self,
        last_index: &u64,
    ) -> PolarsResult<DataFrame> {
        let sql = queries::new_packets_since_index_no_payload(last_index);
        self.query_sql(sql).await
    }

    pub async fn get_packets_customized_no_payload(&self, last_index: &u64, user_sql: &str) -> PolarsResult<DataFrame> {
        let sql = queries::new_packets_customized_no_payload(last_index, user_sql);
        self.query_sql(sql).await
    }

    pub async fn get_packet_by_index(&self, index: u64) -> PolarsResult<DataFrame> {
        let sql = queries::get_packet_by_index(index);
        self.query_sql(sql).await
    }

    pub fn close(&self) {
        let _ = self.done.send(());
    }
}

/*impl Drop for DataFrameActorHandle{
    fn drop(&mut self) {
        self.close()
    }
}*/

pub struct DataFrameActor {
    receiver: mpsc::Receiver<ActorMessage>,
    df: DataFrame,
    // ctx: SQLContext,
    done: watch::Receiver<()>,
    next_index: u64,
}

impl DataFrameActor {
    pub fn new(
        receiver: mpsc::Receiver<ActorMessage>,
        done: watch::Receiver<()>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let df = create_capture_df();
        // let mut ctx = SQLContext::new();
        // ctx.register("lazy", df.clone().lazy());
        Ok(Self {
            receiver,
            df,
            // ctx,
            done,
            next_index: 0,
        })
    }

    pub async fn run(self) -> Result<()> {
        let Self {
            mut receiver,
            mut df,
            // mut ctx,
            mut done,
            mut next_index,
        } = self;

        loop {
            let event = tokio::select! {
            biased;

            _ = done.changed() => ActorEvent::Shutdown,
            Some(msg) = receiver.recv() => ActorEvent::Message(msg),

            else => {
                return Err(anyhow!("All channels closed"));
            }
            };
            match event {
                ActorEvent::Message(msg) => match msg {
                    ActorMessage::UpdateBatch(batch) => {
                        data_processing::write_batch_to_df(&batch, &mut df, &mut next_index)?;
                    }
                    ActorMessage::QuerySql { sql, resp } => {
                        // ctx.unregister("packets");
                        // ctx.register("packets", df.clone().lazy());
                        let mut ctx = SQLContext::new();
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
pub fn create_capture_df() -> DataFrame {
    let schema = Schema::from_iter(vec![
        Field::new("index".into(), DataType::UInt64),
        Field::new("timestamp".into(), DataType::Int64),
        Field::new("uuid".into(), DataType::String),
        Field::new("src_ip".into(), DataType::String),
        Field::new("src_port".into(), DataType::UInt32),
        Field::new("dst_ip".into(), DataType::String),
        Field::new("dst_port".into(), DataType::UInt32),
        Field::new("pid".into(), DataType::Int32),
        Field::new("pname".into(), DataType::String),
        Field::new("type".into(), DataType::UInt32),
        Field::new("length".into(), DataType::UInt32),
        Field::new("is_binary".into(), DataType::Boolean),
        Field::new("payload_utf8".into(), DataType::String),
        Field::new("payload_binary".into(), DataType::Binary),
    ]);

    DataFrame::empty_with_schema(&schema)
}
