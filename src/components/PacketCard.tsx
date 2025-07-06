import { Clock, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import type { HttpPacket } from '@/types';
import { 
  formatTimestamp, 
  formatSize, 
  getMethodColorClass, 
  getStatusColorClass,
  truncateText 
} from '@/utils/httpParser';

interface PacketCardProps {
  packet: HttpPacket;
  onClick: (packet: HttpPacket) => void;
  showTimestamp: boolean;
  isMobile: boolean;
}

export function PacketCard({ packet, onClick, showTimestamp, isMobile }: PacketCardProps) {
  const handleClick = () => {
    onClick(packet);
  };

  const directionIcon = packet.direction === 'request' ? (
    <ArrowUpRight className="h-4 w-4 text-blue-500" />
  ) : (
    <ArrowDownLeft className="h-4 w-4 text-green-500" />
  );

  const methodClass = getMethodColorClass(packet.method);
  const statusClass = packet.statusCode ? getStatusColorClass(packet.statusCode) : '';

  return (
    <div 
      className="packet-card animate-fade-in"
      onClick={handleClick}
    >
      {/* Desktop Layout */}
      <div className={`${isMobile ? 'hidden' : 'block'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3 flex-1 min-w-0">
            {directionIcon}
            
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-normal ${methodClass}`}>
              {packet.method}
            </span>
            
            {packet.statusCode && (
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-normal ${statusClass}`}>
                {packet.statusCode}
              </span>
            )}
            
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                {packet.url || 'No URL'}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Size: {formatSize(packet.size)}
                {packet.duration && ` • ${packet.duration}ms`}
              </p>
            </div>
          </div>
          
          {showTimestamp && (
            <div className="flex items-center text-xs text-gray-500 dark:text-gray-400">
              <Clock className="h-3 w-3 mr-1" />
              {formatTimestamp(packet.timestamp)}
            </div>
          )}
        </div>
      </div>

      {/* Mobile Layout */}
      <div className={`${isMobile ? 'block' : 'hidden'}`}>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {directionIcon}
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-normal ${methodClass}`}>
                {packet.method}
              </span>
              {packet.statusCode && (
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-normal ${statusClass}`}>
                  {packet.statusCode}
                </span>
              )}
            </div>
            
            {showTimestamp && (
              <div className="flex items-center text-xs text-gray-500 dark:text-gray-400">
                <Clock className="h-3 w-3 mr-1" />
                {formatTimestamp(packet.timestamp)}
              </div>
            )}
          </div>
          
          <div>
            <p className="text-sm text-gray-900 dark:text-gray-100 break-all">
              {truncateText(packet.url || 'No URL', 50)}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Size: {formatSize(packet.size)}
              {packet.duration && ` • ${packet.duration}ms`}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
