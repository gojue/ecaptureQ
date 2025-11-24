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

/// 构建带有增量过滤逻辑的 SQL
/// 支持两种输入模式:
/// 1. 完整SQL查询 (以SELECT开头): 使用子查询包裹策略
/// 2. 纯过滤条件: 补全SELECT语句并用括号保护优先级
pub fn new_packets_customized_no_payload(last_index: &u64, user_sql: &str) -> String {
    let trimmed_sql = user_sql.trim();
    
    // 判断用户输入的是"完整SQL"还是"过滤条件"
    // 使用 starts_with 忽略大小写检查
    let is_full_select = trimmed_sql.to_lowercase().starts_with("select");

    if is_full_select {
        // 【策略 A：子查询包裹】(推荐)
        // 这种方式最安全，无论用户 SQL 里面有没有 WHERE，或者有多复杂的 JOIN/UNION，
        // 我们都把它当做一个临时表，在外层过滤 index。
        // 明确指定需要的列以确保类型一致性
        
        // 移除用户可能自带的末尾分号，否则子查询会报错
        let clean_sql = trimmed_sql.trim_end_matches(';');
        
        format!(
            "SELECT index, timestamp, uuid, src_ip, src_port, dst_ip, dst_port, pid, pname, type, length, is_binary FROM ({}) AS custom_view WHERE index > {} ORDER BY index ASC",
            clean_sql, last_index
        )
    } else {
        // 【策略 B：纯条件补全】
        // 用户只输入了: pname = 'curl'
        // 我们将其补全为完整 SQL，并用括号包裹用户条件以防优先级问题
        
        // 如果用户输入为空，处理为 TRUE
        let condition = if trimmed_sql.is_empty() { "1=1" } else { trimmed_sql };

        format!(
            "SELECT index, timestamp, uuid, src_ip, src_port, dst_ip, dst_port, pid, pname, type, length, is_binary FROM packets WHERE ({}) AND index > {} ORDER BY index ASC",
            condition, last_index
        )
    }
}


pub fn get_packet_by_index(index: u64) -> String {
    format!("SELECT * FROM packets WHERE index = {} LIMIT 1", index)
}
