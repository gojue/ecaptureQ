// 后端 API 返回的数据包结构
export interface PacketData {
  timestamp: number;        // Unix 纳秒时间戳 (i64)
  src_ip: string;
  src_port: number;         // u32
  dst_ip: string;
  dst_port: number;         // u32
  pid: number;              // i32
  pname: string;
  type: string;             // 协议类型
  length: number;           // u32 数据大小
  payload_base64: string;
}
