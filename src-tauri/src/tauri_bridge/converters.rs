use crate::core::models::PacketData;
use polars::prelude::*;

pub fn df_to_packet_data_vec(df: &DataFrame) -> PolarsResult<Vec<PacketData>> {
    if df.is_empty() {
        return Ok(Vec::new());
    }

    // 将所有列转换为类型化的迭代器，这是最高效的方式
    let ts_iter = df.column("timestamp")?.i64()?;
    let src_ip_iter = df.column("src_ip")?.str()?;
    let src_port_iter = df.column("src_port")?.u32()?;
    let dst_ip_iter = df.column("dst_ip")?.str()?;
    let dst_port_iter = df.column("dst_port")?.u32()?;
    let pid_iter = df.column("pid")?.i32()?;
    let pname_iter = df.column("pname")?.str()?;
    let type_iter = df.column("type")?.str()?;
    let length_iter = df.column("length")?.u32()?;
    let payload_iter = df.column("payload_base64")?.str()?;

    let mut result_vec = Vec::with_capacity(df.height());

    // 使用 polars::prelude::par_iter_izip! 来并行处理，如果数据量很大，效果会更好
    // 这里为简单起见，先用普通循环
    for i in 0..df.height() {
        // 使用 .get(i) 来安全地获取每个元素
        // Option.unwrap() 在这里是相对安全的，因为我们知道迭代长度是一致的
        result_vec.push(PacketData {
            timestamp: ts_iter.get(i).unwrap(),
            src_ip: src_ip_iter.get(i).unwrap().to_string(),
            src_port: src_port_iter.get(i).unwrap(),
            dst_ip: dst_ip_iter.get(i).unwrap().to_string(),
            dst_port: dst_port_iter.get(i).unwrap(),
            pid: pid_iter.get(i).unwrap(),
            pname: pname_iter.get(i).unwrap().to_string(),
            r#type: type_iter.get(i).unwrap().to_string(),
            length: length_iter.get(i).unwrap(),
            payload_base64: payload_iter.get(i).unwrap().to_string(),
        });
    }

    Ok(result_vec)
}
