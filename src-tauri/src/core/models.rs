use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct PacketData {
    pub timestamp: i64,
    pub ip: Arc<str>,
    pub port: u32,
    pub method: Arc<str>,
    pub path: Arc<str>,
    pub user_agent: Arc<str>,
}

