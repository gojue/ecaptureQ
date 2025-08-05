use crate::core::models::{self, LogType, ParsedMessage};
use polars::prelude::*;

pub fn write_batch_to_df(buffer: &[models::PacketData], df: &mut DataFrame) -> PolarsResult<()> {
    if buffer.is_empty() {
        return Ok(());
    }

    let buffer_len = buffer.len();
    let mut ts_builder = PrimitiveChunkedBuilder::<Int64Type>::new("timestamp".into(), buffer_len);
    let mut uuid_builder = StringChunkedBuilder::new("uuid".into(), buffer_len);
    let mut src_ip_builder = StringChunkedBuilder::new("src_ip".into(), buffer_len);
    let mut src_port_builder =
        PrimitiveChunkedBuilder::<UInt32Type>::new("src_port".into(), buffer_len);
    let mut dst_ip_builder = StringChunkedBuilder::new("dst_ip".into(), buffer_len);
    let mut dst_port_builder =
        PrimitiveChunkedBuilder::<UInt32Type>::new("dst_port".into(), buffer_len);
    let mut pid_builder = PrimitiveChunkedBuilder::<Int32Type>::new("pid".into(), buffer_len);
    let mut pname_builder = StringChunkedBuilder::new("pname".into(), buffer_len);
    let mut type_builder = PrimitiveChunkedBuilder::<UInt32Type>::new("type".into(), buffer_len);
    let mut length_builder =
        PrimitiveChunkedBuilder::<UInt32Type>::new("length".into(), buffer_len);
    let mut payload_builder = StringChunkedBuilder::new("payload_base64".into(), buffer_len);

    for d in buffer {
        ts_builder.append_value(d.timestamp);
        uuid_builder.append_value(&d.uuid);
        src_ip_builder.append_value(&d.src_ip);
        src_port_builder.append_value(d.src_port);
        dst_ip_builder.append_value(&d.dst_ip);
        dst_port_builder.append_value(d.dst_port);
        pid_builder.append_value(d.pid);
        pname_builder.append_value(&d.pname);
        type_builder.append_value(d.r#type);
        length_builder.append_value(d.length);
        payload_builder.append_value(&d.payload_base64);
    }

    let column_vec = vec![
        ts_builder.finish().into_column(),
        uuid_builder.finish().into_column(),
        src_ip_builder.finish().into_column(),
        src_port_builder.finish().into_column(),
        dst_ip_builder.finish().into_column(),
        dst_port_builder.finish().into_column(),
        pid_builder.finish().into_column(),
        pname_builder.finish().into_column(),
        type_builder.finish().into_column(),
        length_builder.finish().into_column(),
        payload_builder.finish().into_column(),
    ];

    let batch_df = DataFrame::new(column_vec)?;
    df.vstack_mut(&batch_df)?;

    Ok(())
}

pub fn parse_eq_message(json_str: &str) -> Result<ParsedMessage, Box<dyn std::error::Error>> {
    let eq_message: models::EqMessage = serde_json::from_str(json_str)?;
    let log_type = LogType::from(eq_message.log_type);
    
    match log_type {
        LogType::Heartbeat => {
            let heartbeat: models::HeartbeatMessage = serde_json::from_value(eq_message.payload)?;
            Ok(ParsedMessage::Heartbeat(heartbeat))
        }
        LogType::ProcessLog => {
            // Parse level, message, time fields from payload
            let log_message = if let Ok(mut log_data) = serde_json::from_value::<serde_json::Map<String, serde_json::Value>>(eq_message.payload.clone()) {
                let level = log_data.remove("level")
                    .and_then(|v| v.as_str().map(|s| s.to_string()));
                let message = log_data.remove("message")
                    .and_then(|v| v.as_str().map(|s| s.to_string()));
                let time = log_data.remove("time")
                    .and_then(|v| v.as_str().map(|s| s.to_string()));
                let log_info = serde_json::to_string(&eq_message.payload)?;
                models::ProcessLogMessage { level, message, time, log_info }
            } else {
                models::ProcessLogMessage {
                    level: Some("unknown".to_string()),
                    message: None,
                    time: None,
                    log_info: serde_json::to_string(&eq_message.payload)?,
                }
            };
            Ok(ParsedMessage::ProcessLog(log_message))
        }
        LogType::Event => {
            let packet_data: models::PacketData = serde_json::from_value(eq_message.payload)?;
            Ok(ParsedMessage::Event(packet_data))
        }
    }
}
