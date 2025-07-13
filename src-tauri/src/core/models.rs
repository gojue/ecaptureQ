use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct PacketData {
    pub timestamp: i64,
    pub src_ip: String,
    pub src_port: u32,
    pub dst_ip: String,
    pub dst_port: u32,
    pub pid: i32,
    pub pname: String,
    pub r#type: String,
    pub length: u32,
    pub payload_base64: String,
}


