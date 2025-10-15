pub fn all_packets() -> String {
    "SELECT * FROM packets".to_string()
}

pub fn new_packets_since_offset(offset: usize) -> String {
    format!("SELECT * FROM packets OFFSET {}", offset)
}

pub fn new_packets_since_index(last_index: u64) -> String {
    format!("SELECT * FROM packets WHERE index > {} ORDER BY index", last_index)
}

pub fn new_packets_since_index_no_payload(last_index: u64) -> String {
    format!(
        "SELECT index, timestamp, uuid, src_ip, src_port, dst_ip, dst_port, pid, pname, type, length, is_binary FROM packets WHERE index > {} ORDER BY index",
        last_index
    )
}

pub fn get_packet_by_index(index: u64) -> String {
    format!(
        "SELECT * FROM packets WHERE index = {} LIMIT 1",
        index
    )
}

