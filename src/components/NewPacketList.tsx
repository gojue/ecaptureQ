import { memo, useEffect, useRef, useState, useCallback } from 'react';
import { FixedSizeList as List } from 'react-window';
import { NewPacketCard } from './NewPacketCard';
import type { PacketData } from '@/types';

interface NewPacketListProps {
  packets: PacketData[];
  onPacketClick: (packet: PacketData) => void;
  showTimestamp?: boolean;
  autoScroll?: boolean;
}

// Single item height (adjusted for mobile card content)
const ITEM_HEIGHT = 100;

// Buffer item count
const OVERSCAN_COUNT = 5;

// 列表项组件
const ListItem = memo(({ index, style, data }: {
  index: number;
  style: React.CSSProperties;
  data: {
    packets: PacketData[];
    onPacketClick: (packet: PacketData) => void;
    showTimestamp: boolean;
  };
}) => {
  const { packets, onPacketClick, showTimestamp } = data;
  const packet = packets[index];

  if (!packet) return null;

  return (
    <div style={style}>
      <div className="px-4 py-1">
        <NewPacketCard
          packet={packet}
          onClick={onPacketClick}
          showTimestamp={showTimestamp}
        />
      </div>
    </div>
  );
});

ListItem.displayName = 'ListItem';

export function NewPacketList({
  packets,
  onPacketClick,
  showTimestamp = true,
  autoScroll = true
}: NewPacketListProps) {
  const listRef = useRef<List>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(600);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const lastPacketCountRef = useRef(0);

  // Check if user is near bottom of the list
  const handleScroll = useCallback(({ scrollOffset, scrollUpdateWasRequested }: any) => {
    if (!scrollUpdateWasRequested && listRef.current) {
      const maxScrollTop = Math.max(0, packets.length * ITEM_HEIGHT - listHeight);
      const threshold = ITEM_HEIGHT * 3; // 3 items from bottom
      const nearBottom = scrollOffset >= maxScrollTop - threshold;
      setIsNearBottom(nearBottom);
    }
  }, [packets.length, listHeight]);

  // Responsive height calculation
  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setListHeight(rect.height);
      }
    };

    // Use timeout to ensure layout is stable
    const timer = setTimeout(updateHeight, 100);
    window.addEventListener('resize', updateHeight);
    
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateHeight);
    };
  }, []);

  // Smart auto scroll - only when user is near bottom
  useEffect(() => {
    if (autoScroll && packets.length > lastPacketCountRef.current && isNearBottom && listRef.current) {
      listRef.current.scrollToItem(packets.length - 1, 'end');
    }
    lastPacketCountRef.current = packets.length;
  }, [packets.length, autoScroll, isNearBottom]);

  const itemData = {
    packets,
    onPacketClick,
    showTimestamp
  };

  if (packets.length === 0) {
    return (
      <div ref={containerRef} className="h-full flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="text-gray-400 dark:text-gray-600 mb-2">
            <svg
              className="w-12 h-12 mx-auto mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2M4 13h2m13-8v.01M6 8v.01"
              />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
            No packets captured yet
          </h3>
          <p className="text-gray-500 dark:text-gray-400">
            Tap the floating button to start capturing
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full bg-gray-50 dark:bg-gray-900">
      <List
        ref={listRef}
        height={listHeight}
        width="100%"
        itemCount={packets.length}
        itemSize={ITEM_HEIGHT}
        itemData={itemData}
        overscanCount={OVERSCAN_COUNT}
        onScroll={handleScroll}
        className="custom-scrollbar"
      >
        {ListItem}
      </List>
    </div>
  );
}
