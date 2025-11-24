export interface PacketData {
  index: number;
  timestamp: number;
  uuid: string;
  src_ip: string;
  src_port: number;
  dst_ip: string;
  dst_port: number;
  pid: number;
  pname: string;
  type: number;
  length: number;
  is_binary: boolean;
}

export interface PacketDataWithPayload extends PacketData {
  payload_utf8: string;
  payload_binary: number[];
}

export interface Configs {
  ws_url?: string;
  ecapture_args?: string;
  user_sql?: string | null;
}
