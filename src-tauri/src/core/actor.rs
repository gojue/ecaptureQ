use tokio::sync::{mpsc, oneshot};
use crate::core::models;
use polars::prelude::*;
use polars::sql::SQLContext;

type Responder<T> = oneshot::Sender<T>;

#[derive(Debug)]
pub enum ActorMessage {
    UpdateBatch(Vec<models::PacketData>),

    QuerySql {
        sql: String,
        resp: Responder<Result<String, Box<dyn std::error::Error> >>,
    },
}

pub struct DataFrameActor {
    receiver: mpsc::Receiver<ActorMessage>,
    df: DataFrame,
    ctx: SQLContext,
}

impl DataFrameActor {
    pub fn new(receiver: mpsc::Receiver<ActorMessage>) -> Result<Self, Box<dyn std::error::Error> > {
        let s0 = Series::new_empty("timestamp".into(), &DataType::Int64);
        let s1 = Series::new_empty("ip".into(), &DataType::String);
        let s2 = Series::new_empty("port".into(), &DataType::UInt32);
        let s3 = Series::new_empty("method".into(), &DataType::String);
        let s4 = Series::new_empty("path".into(), &DataType::String);
        let s5 = Series::new_empty("user_agent".into(), &DataType::String);

        // 创建空的DataFrame
        let df = DataFrame::new(vec![s0.into_column(), s1.into_column(), s2.into_column(), s3.into_column(), s4.into_column(), s5.into_column()])?;
        let mut ctx = SQLContext::new();
        ctx.register("lazy", df.clone().lazy());
        Ok(Self { receiver, df, ctx })
    }

    pub async fn run(self) {
        let Self {
            mut receiver,
            mut df,
            mut ctx,
        } = self;

        loop {
            let msg = tokio::select! {
            Some(msg) = receiver.recv() => msg,

            else => {
                break;
            }
        };
            match msg {
                ActorMessage::UpdateBatch(batch) => {
                    if let Ok(new_df) = process_batch(batch) {
                        if df.vstack_mut(&new_df).is_ok() {
                            unimplemented!()
                        }
                    }
                },
                ActorMessage::QuerySql { sql, resp } => {
                    ctx.unregister("packets");
                    ctx.register("packets", df.clone().lazy());
                    if let Ok(res) = ctx.execute("SELECT path FROM packets") {
                        let lf = res.collect();
                        println!("{:?}", lf);
                    }
                    // let _ = resp.send(result);
                }
            }

        }

    }
}