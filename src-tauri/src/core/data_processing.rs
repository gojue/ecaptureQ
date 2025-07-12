use polars::prelude::*;
use crate::core::models;

async fn write_batch_to_polars(buffer: &[models::PacketData], df: &mut DataFrame) -> Result<(), PolarsError> {
    if buffer.is_empty() {
        return Ok(());
    }

    // 将结构体Vec转换为列式Vec
    let timestamps: Vec<i64> = buffer.iter().map(|d| d.timestamp).collect();
    let ips: Vec<&str> = buffer.iter().map(|d| d.ip.as_ref()).collect();
    let ports: Vec<u32> = buffer.iter().map(|d| d.port).collect();
    let methods: Vec<&str> = buffer.iter().map(|d| d.method.as_ref()).collect();
    let paths: Vec<&str> = buffer.iter().map(|d| d.path.as_ref()).collect();
    let user_agents: Vec<&str> = buffer.iter().map(|d| d.user_agent.as_ref()).collect();

    // 手动创建Series
    let s0 = Series::new("timestamp".into(), timestamps);
    let s1 = Series::new("ip".into(), ips);
    let s2 = Series::new("port".into(), ports.as_slice());
    let s3 = Series::new("method".into(), methods);
    let s4 = Series::new("path".into(), paths);
    let s5 = Series::new("user_agent".into(), user_agents);

    // 从Series创建DataFrame
    let batch_df = DataFrame::new(vec![s0.into_column(), s1.into_column(), s2.into_column(), s3.into_column(), s4.into_column(), s5.into_column()])?;

    // 获取DataFrame的锁并追加数据
    df.vstack_mut(&batch_df)?;

    Ok(())
}