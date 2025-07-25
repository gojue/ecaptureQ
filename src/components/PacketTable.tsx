import { memo, useEffect, useRef, useState } from 'react';
import { FixedSizeList as List } from 'react-window';
import type { PacketData } from '@/types';

const ITEM_HEIGHT = 48;

const Row = memo(({ index, style, data }: { 
  index: number; 
  style: React.CSSProperties; 
  data: any 
}) => {
  const packet: PacketData = data.packets[index];
  const { onPacketClick } = data;
  
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp / 1000000);
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit'
    });
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div 
      style={style} 
      onClick={() => onPacketClick(packet)}
      className="flex items-center px-6 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors"
    >
      <div className="w-32 py-3 truncate pr-4 font-mono text-sm text-gray-600 dark:text-gray-400">
        {formatTimestamp(packet.timestamp)}
      </div>
      <div className="w-40 py-3 truncate pr-4 text-sm">
        <span className="font-medium">{packet.pname}</span>
        <span className="text-gray-500 dark:text-gray-400"> ({packet.pid})</span>
      </div>
      <div className="w-48 py-3 truncate pr-4 font-mono text-sm text-gray-600 dark:text-gray-400">
        {packet.src_ip}:{packet.src_port}
      </div>
      <div className="w-48 py-3 truncate pr-4 font-mono text-sm text-gray-600 dark:text-gray-400">
        {packet.dst_ip}:{packet.dst_port}
      </div>
      <div className="w-20 py-3 truncate pr-4 text-sm">
        <span className={`px-2 py-1 rounded text-xs font-medium ${
          packet.type.toLowerCase() === 'tcp' 
            ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300'
            : packet.type.toLowerCase() === 'udp'
            ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300'
            : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
        }`}>
          {packet.type.toUpperCase()}
        </span>
      </div>
      <div className="w-24 py-3 truncate text-right text-sm text-gray-600 dark:text-gray-400">
        {formatSize(packet.length)}
      </div>
    </div>
  );
});

Row.displayName = 'TableRow';

export function PacketTable({ 
  packets, 
  onPacketClick 
}: { 
  packets: PacketData[]; 
  onPacketClick: (p: PacketData) => void;
}) {
  const listRef = useRef<List>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(600);

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setListHeight(rect.height - 48); // Subtract header height
      }
    };

    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  useEffect(() => {
    if (packets.length > 0 && listRef.current) {
      listRef.current.scrollToItem(packets.length - 1, 'end');
    }
  }, [packets.length]);

  if (packets.length === 0) {
    return (
      <div ref={containerRef} className="flex-1 flex items-center justify-center bg-white dark:bg-gray-800">
        <div className="text-center">
          <div className="text-gray-400 dark:text-gray-600 mb-4">
            <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2M4 13h2m13-8v.01M6 8v.01" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
            No packets captured yet
          </h3>
          <p className="text-gray-500 dark:text-gray-400">
            Click "Start" to begin monitoring network traffic
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 flex flex-col bg-white dark:bg-gray-800">
      {/* Table Header */}
      <div className="flex items-center px-6 h-12 bg-gray-50 dark:bg-gray-700/50 border-b-2 border-gray-200 dark:border-gray-600 font-semibold text-sm text-gray-700 dark:text-gray-300">
        <div className="w-32 pr-4">Time</div>
        <div className="w-40 pr-4">Process</div>
        <div className="w-48 pr-4">Source</div>
        <div className="w-48 pr-4">Destination</div>
        <div className="w-20 pr-4">Protocol</div>
        <div className="w-24 text-right">Size</div>
      </div>
      
      {/* Virtual List */}
      <div className="flex-1">
        <List
          ref={listRef}
          height={listHeight}
          itemCount={packets.length}
          itemSize={ITEM_HEIGHT}
          itemData={{ packets, onPacketClick }}
          width="100%"
        >
          {Row}
        </List>
      </div>
    </div>
  );
}
