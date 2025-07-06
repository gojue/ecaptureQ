import type { HttpPacket, WebSocketMessage } from '@/types';
import { decodeBase64, parseHttpData, generatePacketId } from '@/utils/httpParser';

export class WebSocketService {
  private connection: WebSocket | null = null;
  private listeners: ((packet: HttpPacket) => void)[] = [];
  private url: string = '';

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    try {
      this.connection = new WebSocket(this.url);
      
      this.connection.onmessage = (event: MessageEvent) => {
        try {
          const wsMessage: WebSocketMessage = {
            data: event.data,
            timestamp: Date.now(),
          };
          
          this.handleMessage(wsMessage);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.connection.onerror = (error: Event) => {
        console.error('WebSocket error:', error);
      };

      this.connection.onclose = (event: CloseEvent) => {
        console.log('WebSocket closed:', event.code, event.reason);
      };

      return new Promise((resolve, reject) => {
        if (!this.connection) {
          reject(new Error('Failed to create WebSocket connection'));
          return;
        }
        
        this.connection.onopen = () => {
          console.log('WebSocket connected to:', this.url);
          resolve();
        };
        
        setTimeout(() => {
          if (this.connection?.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket connection timeout'));
          }
        }, 5000);
      });
    } catch (error) {
      console.error('Failed to connect to WebSocket:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      try {
        this.connection.close();
        this.connection = null;
        console.log('WebSocket disconnected');
      } catch (error) {
        console.error('Failed to disconnect WebSocket:', error);
      }
    }
  }

  private handleMessage(wsMessage: WebSocketMessage): void {
    try {
      // Parse the JSON data
      const jsonData = JSON.parse(wsMessage.data);
      
      // Extract base64 encoded HTTP data
      const base64Data = jsonData.httpData || jsonData.data;
      if (!base64Data) {
        console.warn('No HTTP data found in WebSocket message');
        return;
      }

      // Decode base64 to get raw HTTP data
      const rawHttpData = decodeBase64(base64Data);
      if (!rawHttpData) {
        console.warn('Failed to decode base64 HTTP data');
        return;
      }

      // Parse HTTP data
      const parsedData = parseHttpData(rawHttpData);
      
      // Determine direction based on the data
      const direction = parsedData.method ? 'request' : 'response';
      
      // Create HTTP packet
      const packet: HttpPacket = {
        id: generatePacketId(),
        timestamp: wsMessage.timestamp,
        method: parsedData.method || 'UNKNOWN',
        url: parsedData.url || '',
        statusCode: parsedData.statusCode,
        headers: parsedData.headers,
        body: parsedData.body,
        rawData: base64Data,
        direction,
        size: rawHttpData.length,
        duration: undefined, // Could be calculated if we track request-response pairs
      };

      // Notify all listeners
      this.listeners.forEach(listener => listener(packet));
    } catch (error) {
      console.error('Failed to handle WebSocket message:', error);
    }
  }

  addPacketListener(listener: (packet: HttpPacket) => void): void {
    this.listeners.push(listener);
  }

  removePacketListener(listener: (packet: HttpPacket) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  isConnected(): boolean {
    return this.connection !== null;
  }

  updateUrl(newUrl: string): void {
    this.url = newUrl;
  }
}
