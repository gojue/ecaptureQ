use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogType {
    Heartbeat = 0,
    ProcessLog = 1,
    Event = 2,
}

impl From<u8> for LogType {
    fn from(value: u8) -> Self {
        match value {
            0 => LogType::Heartbeat,
            1 => LogType::ProcessLog,
            2 => LogType::Event,
            _ => LogType::Event, // 默认当作事件处理
        }
    }
}

#[derive(Debug, Clone)]
pub enum ParsedMessage {
    Heartbeat(HeartbeatMessage),
    ProcessLog(ProcessLogMessage),
    Event(PacketData),
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct PacketData {
    pub index: u64,
    pub timestamp: i64,
    pub uuid: String,
    pub src_ip: String,
    pub src_port: u32,
    pub dst_ip: String,
    pub dst_port: u32,
    #[serde(alias = "process_id", alias = "proc_id")]
    pub pid: i32,
    #[serde(alias = "process_name", alias = "proc_name", alias = "comm")]
    pub pname: String,
    #[serde(rename = "type")]
    pub r#type: u32,
    pub length: u32,
    pub is_binary: bool,
    pub payload_utf8: String,
    pub payload_binary: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PacketDataFrontend {
    pub index: u64,
    pub timestamp: i64,
    pub uuid: String,
    pub src_ip: String,
    pub src_port: u32,
    pub dst_ip: String,
    pub dst_port: u32,
    #[serde(alias = "process_id", alias = "proc_id")]
    pub pid: i32,
    #[serde(alias = "process_name", alias = "proc_name", alias = "comm")]
    pub pname: String,
    #[serde(rename = "type")]
    pub r#type: u32,
    pub length: u32,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HeartbeatMessage {
    pub timestamp: i64,
    pub count: i32,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProcessLogMessage {
    pub log_info: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EqMessage {
    pub log_type: u8,
    pub payload: serde_json::Value,
}
