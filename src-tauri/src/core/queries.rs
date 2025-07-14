pub fn all_packets() -> String {
    "SELECT * FROM packets".to_string()
}

pub fn new_packets_since_offset(offset: usize) -> String {
    format!("SELECT * FROM packets OFFSET {}", offset)
}
