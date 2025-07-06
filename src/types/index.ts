export interface HttpPacket {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  statusCode?: number;
  headers: Record<string, string>;
  body?: string;
  rawData: string; // base64 encoded raw HTTP data
  direction: 'request' | 'response';
  size: number;
  duration?: number;
}

export interface ParsedHttpData {
  method?: string;
  url?: string;
  statusCode?: number;
  statusText?: string;
  headers: Record<string, string>;
  body?: string;
}

export interface WebSocketMessage {
  data: string; // JSON string containing base64 encoded HTTP data
  timestamp: number;
}

export interface AppConfig {
  websocketUrl: string;
  theme: 'light' | 'dark' | 'system';
  autoScroll: boolean;
  maxPackets: number;
  showTimestamp: boolean;
  showHeaders: boolean;
}

export interface FilterOptions {
  methods: string[];
  statusCodes: number[];
  searchText: string;
  timeRange?: {
    start: number;
    end: number;
  };
}
