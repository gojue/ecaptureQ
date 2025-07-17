import { ArrowRight, Monitor } from 'lucide-react';
import type { PacketData } from '@/types';

interface NewPacketCardProps {
  packet: PacketData;
  onClick: (packet: PacketData) => void;
  showTimestamp?: boolean;
}

export function NewPacketCard({ packet, onClick, showTimestamp = true }: NewPacketCardProps) {
  // 格式化时间戳（纳秒转换为可读格式）
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp / 1000000); // 纳秒转毫秒
    const timeStr = date.toLocaleTimeString('en-US', { 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const ms = Math.floor((timestamp % 1000000000) / 1000000); // 提取毫秒部分
    return `${timeStr}.${ms.toString().padStart(3, '0')}`;
  };

  // 格式化数据大小
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // 获取协议类型颜色
  const getProtocolColor = (type: string) => {
    switch (type.toUpperCase()) {
      case 'HTTP':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300';
      case 'HTTPS':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300';
      case 'TCP':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300';
      case 'UDP':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300';
    }
  };

  return (
    <div
      onClick={() => onClick(packet)}
      className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg 
                 p-4 cursor-pointer hover:shadow-md hover:border-blue-300 dark:hover:border-blue-600 
                 transition-all duration-200 animate-fade-in"
    >
      <div className="flex items-start justify-between">
        {/* 左侧：协议和网络信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-2 mb-2">
            {/* 协议类型标签 */}
            <span className={`px-2 py-1 text-xs font-medium rounded-full ${getProtocolColor(packet.type)}`}>
              {packet.type.toUpperCase()}
            </span>
            
            {/* 时间戳 */}
            {showTimestamp && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {formatTimestamp(packet.timestamp)}
              </span>
            )}
          </div>

          {/* 网络连接信息 */}
          <div className="flex items-center space-x-2 text-sm text-gray-700 dark:text-gray-300 mb-2">
            <span className="font-mono">
              {packet.src_ip}:{packet.src_port}
            </span>
            <ArrowRight className="w-3 h-3 text-gray-400" />
            <span className="font-mono">
              {packet.dst_ip}:{packet.dst_port}
            </span>
          </div>

          {/* 进程信息 */}
          <div className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-400">
            <Monitor className="w-3 h-3" />
            <span>{packet.pname}</span>
            <span className="text-gray-400">({packet.pid})</span>
          </div>
        </div>

        {/* 右侧：数据大小 */}
        <div className="text-right">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {formatSize(packet.length)}
          </div>
        </div>
      </div>
    </div>
  );
}
