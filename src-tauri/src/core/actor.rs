use crate::core::data_processing;
use crate::core::models;
use polars::prelude::*;
use polars::sql::SQLContext;
use tokio::sync::{mpsc, oneshot};

type Responder<T> = oneshot::Sender<T>;

#[derive(Debug)]
pub enum ActorMessage {
    UpdateBatch(Vec<models::PacketData>),

    QuerySql {
        sql: String,
        resp: Responder<PolarsResult<DataFrame>>,
    },
}

pub struct DataFrameActor {
    receiver: mpsc::Receiver<ActorMessage>,
    df: DataFrame,
    ctx: SQLContext,
}

impl DataFrameActor {
    pub fn new(receiver: mpsc::Receiver<ActorMessage>) -> Result<Self, Box<dyn std::error::Error>> {
        let df = create_capture_df();
        let mut ctx = SQLContext::new();
        ctx.register("lazy", df.clone().lazy());
        Ok(Self { receiver, df, ctx })
    }

    pub async fn run(self) -> Result<(), Box<dyn std::error::Error>> {
        let Self {
            mut receiver,
            mut df,
            mut ctx,
        } = self;

        loop {
            let msg = tokio::select! {
                Some(msg) = receiver.recv() => msg,

                else => {
                    return Err("Actor msg is invalid".into())
                }
            };
            match msg {
                ActorMessage::UpdateBatch(batch) => {
                    data_processing::write_batch_to_df(&batch, &mut df)?;
                }
                ActorMessage::QuerySql { sql, resp } => {
                    ctx.unregister("packets");
                    ctx.register("packets", df.clone().lazy());
                    let _ = resp.send(ctx.execute(&sql)?.collect());
                }
            }
        }
    }
}

fn create_capture_df() -> DataFrame {
    // 1. 根据你的JSON格式，定义一个精确匹配的 Schema
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
