// Packet data structure returned from backend API (frontend display version)
export interface PacketData {
  index: number;            // u64 unique index for ordering
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
  is_binary: boolean;       // Whether payload is binary data
}

// Full packet data structure with payload (for detail view)
export interface PacketDataWithPayload extends PacketData {
  payload_utf8: string;     // UTF-8 string payload
  payload_binary: number[]; // Binary payload as byte array
}

// Application configuration structure
export interface Configs {
  ws_url?: string;          // WebSocket server address
  ecapture_args?: string;   // eCapture startup arguments
  user_sql?: string | null; // Custom SQL filter for packet stream (null for no filter)
}
