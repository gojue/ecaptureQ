import { X, Clock, Globe, Monitor, Database } from 'lucide-react';
import { useState } from 'react';
import type { PacketData } from '@/types';

interface DetailModalProps {
  packet: PacketData | null;
  onClose: () => void;
}

export function DetailModal({ packet, onClose }: DetailModalProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'payload'>('overview');

  if (!packet) return null;

  // 格式化时间戳
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp / 1000000); // 纳秒转毫秒
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  };

  // 格式化数据大小
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // 解码 Base64 payload
  const decodePayload = (base64: string) => {
    try {
      const decoded = atob(base64);
      return decoded;
    } catch {
      return 'Unable to decode payload';
    }
  };

  // 转换为十六进制显示
  const toHexView = (base64: string) => {
    try {
      const decoded = atob(base64);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        bytes[i] = decoded.charCodeAt(i);
      }
      
      let hex = '';
      let ascii = '';
      let result = '';
      
      for (let i = 0; i < bytes.length; i++) {
        if (i % 16 === 0) {
          if (i > 0) {
            result += `  ${ascii}\n`;
            ascii = '';
          }
          result += i.toString(16).padStart(8, '0') + '  ';
          hex = '';
        }
        
        hex += bytes[i].toString(16).padStart(2, '0') + ' ';
        ascii += bytes[i] >= 32 && bytes[i] <= 126 ? String.fromCharCode(bytes[i]) : '.';
        
        if (i % 8 === 7) hex += ' ';
      }
      
      // 补齐最后一行
      const remaining = 16 - (bytes.length % 16);
      if (remaining !== 16) {
        hex += '   '.repeat(remaining);
        if (remaining > 8) hex += ' ';
      }
      
      result += hex + '  ' + ascii;
      return result;
    } catch {
      return 'Unable to display hex view';
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Packet Details
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setActiveTab('overview')}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${
              activeTab === 'overview'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab('payload')}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${
              activeTab === 'payload'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
            }`}
          >
            Payload
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'overview' ? (
            <div className="space-y-6">
              {/* Basic Information */}
              <div>
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3 flex items-center">
                  <Clock className="w-4 h-4 mr-2" />
                  Basic Information
                </h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Timestamp:</span>
                    <div className="font-mono">{formatTimestamp(packet.timestamp)}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Protocol:</span>
                    <div className="font-semibold">{packet.type.toUpperCase()}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Data Size:</span>
                    <div>{formatSize(packet.length)}</div>
                  </div>
                </div>
              </div>

              {/* Network Information */}
              <div>
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3 flex items-center">
                  <Globe className="w-4 h-4 mr-2" />
                  Network Information
                </h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Source:</span>
                    <div className="font-mono">{packet.src_ip}:{packet.src_port}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Destination:</span>
                    <div className="font-mono">{packet.dst_ip}:{packet.dst_port}</div>
                  </div>
                </div>
              </div>

              {/* Process Information */}
              <div>
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3 flex items-center">
                  <Monitor className="w-4 h-4 mr-2" />
                  Process Information
                </h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Process Name:</span>
                    <div className="font-semibold">{packet.pname}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Process ID:</span>
                    <div>{packet.pid}</div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center">
                <Database className="w-4 h-4 mr-2" />
                Payload Data
              </h3>
              
              {/* Raw Text */}
              <div>
                <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Raw Text:</h4>
                <div className="bg-gray-100 dark:bg-gray-900 rounded-md p-3 max-h-40 overflow-auto">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                    {decodePayload(packet.payload_base64)}
                  </pre>
                </div>
              </div>

              {/* Hex View */}
              <div>
                <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Hex View:</h4>
                <div className="bg-gray-100 dark:bg-gray-900 rounded-md p-3 max-h-60 overflow-auto">
                  <pre className="text-xs font-mono whitespace-pre">
                    {toHexView(packet.payload_base64)}
                  </pre>
                </div>
              </div>

              {/* Base64 */}
              <div>
                <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Base64:</h4>
                <div className="bg-gray-100 dark:bg-gray-900 rounded-md p-3 max-h-32 overflow-auto">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                    {packet.payload_base64}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
