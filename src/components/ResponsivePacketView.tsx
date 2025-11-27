import { memo, useEffect, useRef, useState, useCallback } from "react";
import { FixedSizeList as List } from "react-window";
import { NewPacketCard } from "./NewPacketCard";
import type { PacketData } from "@/types";
import { useResponsive } from "@/hooks/useResponsive";
import { formatTimestamp as formatTimestampUtil } from "@/utils/timeUtils";

interface ResponsivePacketViewProps {
  packets: PacketData[];
  onPacketClick: (packet: PacketData) => void;
  viewMode: "table" | "cards";
  autoScroll?: boolean;
}

// Constants for card view
const CARD_HEIGHT = 100;
const TABLE_ROW_HEIGHT = 48;

// Table Row Component
const TableRow = memo(
  ({
    index,
    style,
    data,
  }: {
    index: number;
    style: React.CSSProperties;
    data: any;
  }) => {
    const packet: PacketData = data.packets[index];
    const { onPacketClick } = data;

    const formatTimestamp = (timestamp: number) => {
      return formatTimestampUtil(timestamp);
    };

    const formatSize = (bytes: number) => {
      try {
        if (!bytes || isNaN(bytes) || bytes < 0) return "0 B";
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      } catch (error) {
        console.error("Size formatting error:", error);
        return "Error";
      }
    };

    const getProtocolInfo = (type: number) => {
      try {
        if (type === undefined || type === null || isNaN(type)) {
          return {
            name: "Unknown",
            color:
              "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
          };
        }
        const protocolMap: { [key: number]: { name: string; color: string } } =
          {
            0: {
              name: "Unknown",
              color:
                "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
            },
            1: {
              name: "HttpRequest",
              color:
                "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
            },
            2: {
              name: "Http2Request",
              color:
                "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300",
            },
            3: {
              name: "HttpResponse",
              color:
                "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300",
            },
            4: {
              name: "Http2Response",
              color:
                "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
            },
            5: {
              name: "WebSocket",
              color:
                "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
            },
          };
        return (
          protocolMap[type] || {
            name: `Unknown (${type})`,
            color:
              "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
          }
        );
      } catch (error) {
        console.error("Protocol info error:", error);
        return {
          name: "Error",
          color:
            "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
        };
      }
    };

    return (
      <div
        style={style}
        onClick={() => {
          try {
            onPacketClick(packet);
          } catch (error) {
            console.error("TableRow onClick error:", error);
          }
        }}
        className="flex items-center px-6 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors"
      >
        <div className="w-32 py-3 truncate pr-4 font-mono text-sm text-gray-600 dark:text-gray-400">
          {formatTimestamp(packet.timestamp)}
        </div>
        <div className="w-40 py-3 truncate pr-4 text-sm">
          <span className="font-medium">{packet.pname || "N/A"}</span>
          <span className="text-gray-500 dark:text-gray-400">
            {" "}
            ({packet.pid !== undefined ? packet.pid : "N/A"})
          </span>
        </div>
        <div className="w-48 py-3 truncate pr-4 font-mono text-sm text-gray-600 dark:text-gray-400">
          {packet.src_ip || "N/A"}:{packet.src_port || 0}
        </div>
        <div className="w-48 py-3 truncate pr-4 font-mono text-sm text-gray-600 dark:text-gray-400">
          {packet.dst_ip || "N/A"}:{packet.dst_port || 0}
        </div>
        <div className="w-32 py-3 pr-4 text-sm">
          <span
            className={`px-2 py-1 rounded text-xs font-medium ${getProtocolInfo(packet.type).color}`}
          >
            {getProtocolInfo(packet.type).name}
          </span>
        </div>
        <div className="w-24 py-3 truncate text-right text-sm text-gray-600 dark:text-gray-400">
          {formatSize(packet.length)}
        </div>
      </div>
    );
  },
);

// Card Row Component
const CardRow = memo(
  ({
    index,
    style,
    data,
  }: {
    index: number;
    style: React.CSSProperties;
    data: {
      packets: PacketData[];
      onPacketClick: (packet: PacketData) => void;
    };
  }) => {
    const { packets, onPacketClick } = data;
    const packet = packets[index];

    if (!packet) return null;

    return (
      <div style={style}>
        <div className="px-4 py-1">
          <NewPacketCard
            packet={packet}
            onClick={onPacketClick}
            showTimestamp={true}
          />
        </div>
      </div>
    );
  },
);

TableRow.displayName = "TableRow";
CardRow.displayName = "CardRow";

export function ResponsivePacketView({
  packets,
  onPacketClick,
  viewMode,
  autoScroll = true,
}: ResponsivePacketViewProps) {
  const listRef = useRef<List>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(600);
  const { isMobile } = useResponsive();
  const [isNearBottom, setIsNearBottom] = useState(true); // Track if user is near bottom

  // Unified scroll event handler for both desktop and mobile
  const handleScroll = useCallback(
    ({ scrollOffset }: any) => {
      if (packets.length === 0) return;

      const itemHeight = viewMode === "table" ? TABLE_ROW_HEIGHT : CARD_HEIGHT;
      const totalHeight = packets.length * itemHeight;
      const visibleHeight = listHeight;
      const distanceFromBottom = totalHeight - (scrollOffset + visibleHeight);

      // Consider near bottom if within one item height from bottom
      setIsNearBottom(distanceFromBottom <= itemHeight);
    },
    [packets.length, listHeight, viewMode],
  );

  // Unified smart auto-scroll logic for both desktop and mobile
  useEffect(() => {
    if (autoScroll && packets.length > 0 && listRef.current && isNearBottom) {
      listRef.current.scrollToItem(packets.length - 1);
    }
  }, [packets.length, autoScroll, isNearBottom]);

  // Update list height based on container size
  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        // Set bottom margin based on device type: mobile needs less, desktop needs more
        const bottomMargin = isMobile ? 10 : 40;
        const availableHeight = window.innerHeight - rect.top - bottomMargin;
        setListHeight(Math.max(200, availableHeight));
      }
    };

    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  const itemData = {
    packets,
    onPacketClick,
  };

  const itemHeight = viewMode === "table" ? TABLE_ROW_HEIGHT : CARD_HEIGHT;
  const RowComponent = viewMode === "table" ? TableRow : CardRow;

  return (
    <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
      {viewMode === "table" && (
        // Table Header
        <div className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 flex items-center px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 flex-shrink-0">
          <div className="w-32 pr-4">Time</div>
          <div className="w-40 pr-4">Process</div>
          <div className="w-48 pr-4">Source</div>
          <div className="w-48 pr-4">Destination</div>
          <div className="w-32 pr-4">Protocol</div>
          <div className="w-24 text-right">Size</div>
        </div>
      )}

      {packets.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400">
          <div className="text-center">
            <p className="text-lg font-medium">No packets captured yet</p>
            <p className="text-sm mt-1">
              Start capturing to see network packets
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <List
            ref={listRef}
            height={listHeight}
            width="100%"
            itemCount={packets.length}
            itemSize={itemHeight}
            itemData={itemData}
            overscanCount={5}
            onScroll={handleScroll}
          >
            {RowComponent}
          </List>
        </div>
      )}
    </div>
  );
}
