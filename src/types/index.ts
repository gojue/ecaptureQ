// Packet data structure returned from backend API
export interface PacketData {
  timestamp: number;        // Unix timestamp in seconds (i64)
  uuid: string;             // Packet unique identifier
  src_ip: string;
  src_port: number;         // u32
  dst_ip: string;
  dst_port: number;         // u32
  pid: number;              // i32
  pname: string;
  type: number;             // Protocol type (u32)
  length: number;           // u32 data size
  payload_base64: string;
}

// Application configuration structure
export interface Configs {
  ws_url?: string;          // WebSocket server address
  ecapture_args?: string;   // eCapture startup arguments
}
