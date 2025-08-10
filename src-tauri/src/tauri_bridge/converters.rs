// External crates
use polars::prelude::*;

// Internal modules
use crate::core::models::PacketData;

pub fn df_to_packet_data_vec(df: &DataFrame) -> PolarsResult<Vec<PacketData>> {
    if df.is_empty() {
        return Ok(Vec::new());
    }

    // Convert all columns to typed iterators for efficiency
    let ts_iter = df.column("timestamp")?.i64()?;
    let uuid_iter = df.column("uuid")?.str()?;
    let src_ip_iter = df.column("src_ip")?.str()?;
    let src_port_iter = df.column("src_port")?.u32()?;
    let dst_ip_iter = df.column("dst_ip")?.str()?;
    let dst_port_iter = df.column("dst_port")?.u32()?;
    let pid_iter = df.column("pid")?.i32()?;
    let pname_iter = df.column("pname")?.str()?;
    let type_iter = df.column("type")?.u32()?;
    let length_iter = df.column("length")?.u32()?;
    let payload_iter = df.column("payload_base64")?.str()?;

    let mut result_vec = Vec::with_capacity(df.height());

    // Use simple loop for now (parallel processing could be added for large datasets)
    for i in 0..df.height() {
        // Use .get(i) to safely get elements - unwrap is safe here since iteration length is consistent
        result_vec.push(PacketData {
            timestamp: ts_iter.get(i).unwrap(),
            uuid: uuid_iter.get(i).unwrap().to_string(),
            src_ip: src_ip_iter.get(i).unwrap().to_string(),
            src_port: src_port_iter.get(i).unwrap(),
            dst_ip: dst_ip_iter.get(i).unwrap().to_string(),
            dst_port: dst_port_iter.get(i).unwrap(),
            pid: pid_iter.get(i).unwrap(),
            pname: pname_iter.get(i).unwrap().to_string(),
            r#type: type_iter.get(i).unwrap(),
            length: length_iter.get(i).unwrap(),
            payload_base64: payload_iter.get(i).unwrap().to_string(),
        });
    }

    Ok(result_vec)
}
