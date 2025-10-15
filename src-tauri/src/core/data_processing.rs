use crate::core::models::{self, ParsedMessage};
use polars::prelude::*;
use prost::Message;

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

use anyhow::{anyhow, Ok, Result};

pub fn write_batch_to_df(buffer: &[models::PacketData], df: &mut DataFrame, next_index: &mut u64) -> PolarsResult<()> {
    if buffer.is_empty() {
        return PolarsResult::Ok(());
    }

    let buffer_len = buffer.len();
    let mut index_builder = PrimitiveChunkedBuilder::<UInt64Type>::new("index".into(), buffer_len);
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
    let mut is_binary_builder = BooleanChunkedBuilder::new("is_binary".into(), buffer_len);
    let mut payload_utf8_builder = StringChunkedBuilder::new("payload_utf8".into(), buffer_len);
    let mut payload_binary_builder = BinaryChunkedBuilder::new("payload_binary".into(), buffer_len);

    for d in buffer {
        index_builder.append_value(*next_index);
        *next_index += 1; // Increment index for next packet
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
        is_binary_builder.append_value(d.is_binary);
        payload_utf8_builder.append_value(&d.payload_utf8);
        payload_binary_builder.append_value(&d.payload_binary);
    }

    let column_vec = vec![
        index_builder.finish().into_column(),
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
        is_binary_builder.finish().into_column(),
        payload_utf8_builder.finish().into_column(),
        payload_binary_builder.finish().into_column(),
    ];

    let batch_df = DataFrame::new(column_vec)?;
    df.vstack_mut(&batch_df)?;

    PolarsResult::Ok(())
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
            // Map to simplified ProcessLogMessage
            let log_message = models::ProcessLogMessage {
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

    // Check if payload is UTF-8 or binary
    let is_binary = !is_utf8_prefix(&ev.payload);
    
    let (payload_utf8, payload_binary) = if is_binary {
        // Binary payload: store as Vec<u8>, empty string for UTF-8
        (String::new(), ev.payload)
    } else {
        // UTF-8 payload: store as string, empty Vec for binary
        match String::from_utf8(ev.payload.clone()) {
            std::result::Result::Ok(utf8_str) => (utf8_str, Vec::new()),
            std::result::Result::Err(_) => {
                // Fallback: treat as binary if conversion fails
                (String::new(), ev.payload)
            }
        }
    };

    models::PacketData {
        index: 0, // Temporary: will be assigned in DataFrame
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
        is_binary,
        payload_utf8,
        payload_binary,
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

pub fn is_utf8_prefix<T: AsRef<[u8]>>(data: T) -> bool {
    let bytes = data.as_ref();

    const MAX_CHECK_LEN: usize = 100;
    let check_len = bytes.len().min(MAX_CHECK_LEN);
    let prefix = &bytes[..check_len];

    match std::str::from_utf8(prefix) {
        std::result::Result::Ok(_) => true,
        std::result::Result::Err(e) => {
            // If error_len is None, it means the error is at the end of the input,
            // indicating that what we have so far is valid UTF-8 (just incomplete)
            e.error_len().is_none()
        }
    }
}
