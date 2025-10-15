import { ArrowRight, Monitor } from 'lucide-react';
import type { PacketData } from '@/types';
import { formatTimestamp as formatTimestampUtil } from '@/utils/timeUtils';

interface NewPacketCardProps {
  packet: PacketData;
  onClick: (packet: PacketData) => void;
  showTimestamp?: boolean;
}

export function NewPacketCard({ packet, onClick, showTimestamp = true }: NewPacketCardProps) {
  try {
    // Use utility function for timestamp formatting (handles nanosecond precision)
    const formatTimestamp = (timestamp: number) => {
      return formatTimestampUtil(timestamp);
    };

  // Format data size
  const formatSize = (bytes: number) => {
    try {
      if (!bytes || isNaN(bytes) || bytes < 0) return '0 B';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } catch (error) {
      console.error('Size formatting error:', error);
      return 'Error';
    }
  };

  // Get protocol info
  const getProtocolInfo = (type: number) => {
    try {
      if (type === undefined || type === null || isNaN(type)) {
        return { name: 'Unknown', color: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300' };
      }
      const protocolMap: { [key: number]: { name: string; color: string } } = {
        0: { name: 'Unknown', color: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300' },
        1: { name: 'HttpRequest', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300' },
        2: { name: 'Http2Request', color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300' },
        3: { name: 'HttpResponse', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300' },
        4: { name: 'Http2Response', color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300' },
        5: { name: 'WebSocket', color: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300' }
      };
      return protocolMap[type] || { name: `Unknown (${type})`, color: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300' };
    } catch (error) {
      console.error('Protocol info error:', error);
      return { name: 'Error', color: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300' };
    }
  };

  return (
    <div
      onClick={() => {
        try {
          onClick(packet);
        } catch (error) {
          console.error('NewPacketCard onClick error:', error);
        }
      }}
      className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg 
                 p-3 cursor-pointer hover:shadow-md hover:border-blue-300 dark:hover:border-blue-600 
                 transition-all duration-200"
    >
      <div className="flex items-center justify-between mb-2">
        {/* Protocol and timestamp */}
        <div className="flex items-center space-x-2">
          <span className={`px-2 py-0.5 text-xs font-medium rounded ${getProtocolInfo(packet.type).color}`}>
            {getProtocolInfo(packet.type).name}
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
          {packet.src_ip || 'N/A'}:{packet.src_port || 0}
        </span>
        <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
        <span className="font-mono truncate">
          {packet.dst_ip || 'N/A'}:{packet.dst_port || 0}
        </span>
      </div>

      {/* Process info */}
      <div className="flex items-center space-x-1 text-xs text-gray-600 dark:text-gray-400">
        <Monitor className="w-3 h-3 flex-shrink-0" />
        <span className="truncate">
          {packet.pname || 'N/A'}
        </span>
        <span className="text-gray-400">
          ({packet.pid !== undefined ? packet.pid : 'N/A'})
        </span>
      </div>
    </div>
  );
  } catch (error) {
    console.error('NewPacketCard render error:', error);
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
        <div className="text-red-600 dark:text-red-400 text-xs font-medium">
          Error loading packet card
        </div>
        <div className="text-red-500 dark:text-red-500 text-xs mt-1">
          {String(error)}
        </div>
      </div>
    );
  }
}
