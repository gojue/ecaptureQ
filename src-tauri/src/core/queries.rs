pub fn all_packets() -> String {
    "SELECT * FROM packets".to_string()
}

pub fn new_packets_since_offset(offset: usize) -> String {
    format!("SELECT * FROM packets OFFSET {}", offset)
}

pub fn new_packets_since_index(last_index: u64) -> String {
    format!(
        "SELECT * FROM packets WHERE index > {} ORDER BY index",
        last_index
    )
}

pub fn new_packets_since_index_no_payload(last_index: &u64) -> String {
    format!(
        "SELECT index, timestamp, uuid, src_ip, src_port, dst_ip, dst_port, pid, pname, type, length, is_binary FROM packets WHERE index > {} ORDER BY index",
        last_index
    )
}

pub fn new_packets_customized_no_payload(last_index: &u64, user_sql: &str) -> String {
    let trimmed_sql = user_sql.trim();

    const TARGET_COLS: &str = "index, timestamp, uuid, src_ip, src_port, dst_ip, dst_port, pid, pname, type, length, is_binary";

    let is_full_select = trimmed_sql.to_lowercase().starts_with("select");

    if is_full_select {
        let clean_sql = trimmed_sql.trim_end_matches(|c| c == ';' || c == ' ');

        format!(
            "SELECT {} FROM ({}) AS user_view WHERE index > {} ORDER BY index ASC",
            TARGET_COLS, clean_sql, last_index
        )
    } else {
        let condition = if trimmed_sql.is_empty() {
            "1=1"
        } else {
            trimmed_sql
        };

        format!(
            "SELECT {} FROM packets WHERE ({}) AND index > {} ORDER BY index ASC",
            TARGET_COLS, condition, last_index
        )
    }
}

pub fn get_packet_by_index(index: u64) -> String {
    format!("SELECT * FROM packets WHERE index = {} LIMIT 1", index)
}
