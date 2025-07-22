import { ArrowRight, Monitor } from 'lucide-react';
import type { PacketData } from '@/types';

interface NewPacketCardProps {
  packet: PacketData;
  onClick: (packet: PacketData) => void;
  showTimestamp?: boolean;
}

export function NewPacketCard({ packet, onClick, showTimestamp = true }: NewPacketCardProps) {
  // Format timestamp (nanoseconds to readable format)
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp / 1000000);
    return date.toLocaleTimeString('en-US', { 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  // Format data size
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Get protocol type color
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
                 p-3 cursor-pointer hover:shadow-md hover:border-blue-300 dark:hover:border-blue-600 
                 transition-all duration-200"
    >
      <div className="flex items-center justify-between mb-2">
        {/* Protocol and timestamp */}
        <div className="flex items-center space-x-2">
          <span className={`px-2 py-0.5 text-xs font-medium rounded ${getProtocolColor(packet.type)}`}>
            {packet.type.toUpperCase()}
          </span>
          {showTimestamp && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {formatTimestamp(packet.timestamp)}
            </span>
          )}
        </div>
        
        {/* Data size */}
        <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
          {formatSize(packet.length)}
        </span>
      </div>

      {/* Network connection */}
      <div className="flex items-center space-x-1 text-xs text-gray-700 dark:text-gray-300 mb-1">
        <span className="font-mono truncate">
          {packet.src_ip}:{packet.src_port}
        </span>
        <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
        <span className="font-mono truncate">
          {packet.dst_ip}:{packet.dst_port}
        </span>
      </div>

      {/* Process info */}
      <div className="flex items-center space-x-1 text-xs text-gray-600 dark:text-gray-400">
        <Monitor className="w-3 h-3 flex-shrink-0" />
        <span className="truncate">{packet.pname}</span>
        <span className="text-gray-400">({packet.pid})</span>
      </div>
    </div>
  );
}
