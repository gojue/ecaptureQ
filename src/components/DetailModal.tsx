import { X, Clock, Globe, Monitor, Database } from "lucide-react";
import { useState, useEffect } from "react";
import type { PacketData } from "@/types";
import { ApiService } from "@/services/apiService";
import { useResponsive } from "@/hooks/useResponsive";
import { formatTimestamp } from "@/utils/timeUtils";

interface DetailModalProps {
  packet: PacketData | null;
  onClose: () => void;
}

export function DetailModal({ packet, onClose }: DetailModalProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "payload">(
    "overview",
  );
  const [decodedPayload, setDecodedPayload] = useState<string>("Loading...");
  const { isMobile } = useResponsive();

  if (!packet) return null;

  // Validate packet data
  const validatePacket = (packet: PacketData) => {
    const issues = [];
    if (typeof packet !== "object") issues.push("packet is not an object");
    if (packet.index === undefined || packet.index === null)
      issues.push("index is missing");
    if (packet.timestamp === undefined || packet.timestamp === null)
      issues.push("timestamp is missing");
    if (packet.uuid === undefined || packet.uuid === null)
      issues.push("uuid is missing");
    if (packet.type === undefined || packet.type === null)
      issues.push("type is missing");
    if (packet.length === undefined || packet.length === null)
      issues.push("length is missing");
    if (packet.is_binary === undefined || packet.is_binary === null)
      issues.push("is_binary is missing");

    if (issues.length > 0) {
      console.warn("Packet validation issues:", issues, packet);
    }
    return issues.length === 0;
  };

  if (!validatePacket(packet)) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-yellow-600">
              Invalid Packet Data
            </h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            The packet data is incomplete or invalid.
          </p>
          <div className="mt-4 p-3 bg-gray-100 dark:bg-gray-900 rounded text-xs font-mono max-h-40 overflow-auto">
            {JSON.stringify(packet, null, 2)}
          </div>
        </div>
      </div>
    );
  }

  try {
    // Format timestamp - now handles nanosecond precision timestamps
    const formatTimestampWithDate = (timestamp: number) => {
      return formatTimestamp(timestamp, { includeDate: true });
    };

    // Format data size
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

    // Load full packet data with payload using backend API
    useEffect(() => {
      const loadPayload = async () => {
        try {
          setDecodedPayload("Loading...");
          const fullPacket = await ApiService.getPacketWithPayload(
            packet.index,
          );

          if (fullPacket.is_binary) {
            // Display binary data as hex dump
            const hexDump = fullPacket.payload_binary
              .map((byte, i) => {
                const hex = byte.toString(16).padStart(2, "0");
                if (i % 16 === 0) {
                  return `\n${i.toString(16).padStart(4, "0")}: ${hex}`;
                } else if (i % 8 === 0) {
                  return `  ${hex}`;
                } else {
                  return ` ${hex}`;
                }
              })
              .join("");
            setDecodedPayload(
              `Binary data (${fullPacket.payload_binary.length} bytes):${hexDump}`,
            );
          } else {
            // Display UTF-8 text
            setDecodedPayload(fullPacket.payload_utf8 || "No text payload");
          }
        } catch (error) {
          setDecodedPayload(`Unable to load payload: ${error}`);
        }
      };

      loadPayload();
    }, [packet.index]);

    // Protocol type mapping
    const getProtocolName = (type: number) => {
      try {
        if (type === undefined || type === null || isNaN(type)) {
          return "Unknown";
        }
        const protocolMap: { [key: number]: string } = {
          0: "Unknown",
          1: "HttpRequest",
          2: "Http2Request",
          3: "HttpResponse",
          4: "Http2Response",
          5: "WebSocket",
        };
        return protocolMap[type] || `Unknown (${type})`;
      } catch (error) {
        console.error("Protocol name error:", error);
        return "Error";
      }
    };

    return (
      <div
        className={`fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 ${
          isMobile ? "pt-[env(safe-area-inset-top)] p-0" : "p-4"
        }`}
      >
        <div
          className={`bg-white dark:bg-gray-800 rounded-lg shadow-xl flex flex-col ${
            isMobile
              ? "w-full h-full max-h-none rounded-none"
              : "max-w-4xl w-full max-h-[90vh]"
          }`}
        >
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
              onClick={() => setActiveTab("overview")}
              className={`px-4 py-2 text-sm font-medium border-b-2 ${
                activeTab === "overview"
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab("payload")}
              className={`px-4 py-2 text-sm font-medium border-b-2 ${
                activeTab === "payload"
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              }`}
            >
              Payload
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-4 flex flex-col">
            {activeTab === "overview" ? (
              <div className="space-y-6">
                {/* Basic Information */}
                <div>
                  <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3 flex items-center">
                    <Clock className="w-4 h-4 mr-2" />
                    Basic Information
                  </h3>
                  <div
                    className={`gap-4 text-sm ${isMobile ? "grid-cols-1" : "grid-cols-2"} grid`}
                  >
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">
                        Timestamp:
                      </span>
                      <div className="font-mono">
                        {formatTimestampWithDate(packet.timestamp)}
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">
                        UUID:
                      </span>
                      <div
                        className={`font-mono text-xs break-all ${isMobile ? "pr-4" : ""}`}
                      >
                        {packet.uuid || "N/A"}
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">
                        Protocol Type:
                      </span>
                      <div className="font-semibold">
                        {getProtocolName(packet.type)}
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">
                        Data Size:
                      </span>
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
                  <div
                    className={`gap-4 text-sm ${isMobile ? "grid-cols-1" : "grid-cols-2"} grid`}
                  >
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">
                        Source:
                      </span>
                      <div className="font-mono">
                        {packet.src_ip || "N/A"}:{packet.src_port || 0}
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">
                        Destination:
                      </span>
                      <div className="font-mono">
                        {packet.dst_ip || "N/A"}:{packet.dst_port || 0}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Process Information */}
                <div>
                  <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3 flex items-center">
                    <Monitor className="w-4 h-4 mr-2" />
                    Process Information
                  </h3>
                  <div
                    className={`gap-4 text-sm ${isMobile ? "grid-cols-1" : "grid-cols-2"} grid`}
                  >
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">
                        Process Name:
                      </span>
                      <div className="font-semibold">
                        {packet.pname || "N/A"}
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">
                        Process ID:
                      </span>
                      <div>{packet.pid !== undefined ? packet.pid : "N/A"}</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col h-full">
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center mb-4">
                  <Database className="w-4 h-4 mr-2" />
                  Payload Data
                </h3>

                {/* Payload Content */}
                <div className="flex-1 flex flex-col">
                  <div
                    className={`bg-gray-100 dark:bg-gray-900 rounded-md p-4 overflow-auto flex-1 ${
                      isMobile ? "mb-4" : "mb-0"
                    }`}
                  >
                    <pre className="text-sm font-mono whitespace-pre-wrap break-all">
                      {decodedPayload}
                    </pre>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  } catch (error) {
    console.error("DetailModal render error:", error);
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-red-600">
              Error Loading Packet
            </h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            There was an error loading the packet details. Please try again.
          </p>
          <div className="mt-4 p-3 bg-gray-100 dark:bg-gray-900 rounded text-xs font-mono">
            {String(error)}
          </div>
        </div>
      </div>
    );
  }
}
