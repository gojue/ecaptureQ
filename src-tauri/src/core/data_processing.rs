use crate::core::models::{self, ParsedMessage};
use polars::prelude::*;
use prost::Message;
use std::io::Cursor;
use base64::Engine as _;

pub mod ecaptureq {
    pub mod events {
        include!(concat!(env!("OUT_DIR"), "/ecaptureq.events.rs"));
    }
}

use ecaptureq::events::{
    log_entry, // oneof payload 的内部模块
    Event as PbEvent,
    Heartbeat as PbHeartbeat,
    LogEntry as PbLogEntry,
};

use anyhow::{Result, anyhow};

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


pub fn parse_eq_message<B: AsRef<[u8]>>(
    bytes: B,
) -> Result<ParsedMessage> {
    // Decode protobuf LogEntry from bytes
    let entry = PbLogEntry::decode(bytes.as_ref())?;

    match entry.payload {
        Some(log_entry::Payload::EventPayload(ev)) => {
            Ok(ParsedMessage::Event(pb_event_to_packet(ev)))
        }
        Some(log_entry::Payload::HeartbeatPayload(hb)) => {
            Ok(ParsedMessage::Heartbeat(pb_heartbeat_to_model(hb)))
        }
        Some(log_entry::Payload::RunLog(runlog)) => {
            // We only have a raw string from protobuf; map to our ProcessLogMessage
            let log_message = models::ProcessLogMessage {
                level: None,
                message: Some(runlog.clone()),
                time: None,
                log_info: runlog,
            };
            Ok(ParsedMessage::ProcessLog(log_message))
        }
        None => Err(anyhow!("missing payload in LogEntry")),
    }
}

fn pb_event_to_packet(ev: PbEvent) -> models::PacketData {
    // Saturating cast for pid (i64 -> i32)
    let pid = if ev.pid > i32::MAX as i64 {
        i32::MAX
    } else if ev.pid < i32::MIN as i64 {
        i32::MIN
    } else {
        ev.pid as i32
    };

    let payload_b64 = base64::engine::general_purpose::STANDARD.encode(&ev.payload);

    models::PacketData {
        timestamp: ev.timestamp,
        uuid: ev.uuid,
        src_ip: ev.src_ip,
        src_port: ev.src_port,
        dst_ip: ev.dst_ip,
        dst_port: ev.dst_port,
        pid,
        pname: ev.pname,
        r#type: ev.r#type,
        length: ev.length,
        payload_base64: payload_b64,
    }
}

fn pb_heartbeat_to_model(hb: PbHeartbeat) -> models::HeartbeatMessage {
    let count = if hb.count > i32::MAX as i64 {
        i32::MAX
    } else if hb.count < i32::MIN as i64 {
        i32::MIN
    } else {
        hb.count as i32
    };

    models::HeartbeatMessage {
        timestamp: hb.timestamp,
        count,
        message: hb.message,
    }
}
