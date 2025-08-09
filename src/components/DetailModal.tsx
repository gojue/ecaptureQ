import { X, Clock, Globe, Monitor, Database } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { PacketData } from '@/types';
import { ApiService } from '@/services/apiService';

interface DetailModalProps {
  packet: PacketData | null;
  onClose: () => void;
}

export function DetailModal({ packet, onClose }: DetailModalProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'payload'>('overview');
  const [decodedPayload, setDecodedPayload] = useState<string>('Loading...');

  if (!packet) return null;

  // Validate packet data
  const validatePacket = (packet: PacketData) => {
    const issues = [];
    if (typeof packet !== 'object') issues.push('packet is not an object');
    if (packet.timestamp === undefined || packet.timestamp === null) issues.push('timestamp is missing');
    if (packet.uuid === undefined || packet.uuid === null) issues.push('uuid is missing');
    if (packet.type === undefined || packet.type === null) issues.push('type is missing');
    if (packet.length === undefined || packet.length === null) issues.push('length is missing');
    if (packet.payload_base64 === undefined || packet.payload_base64 === null) issues.push('payload_base64 is missing');
    
    if (issues.length > 0) {
      console.warn('Packet validation issues:', issues, packet);
    }
    return issues.length === 0;
  };

  if (!validatePacket(packet)) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-yellow-600">Invalid Packet Data</h2>
            <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md">
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
    // Format timestamp - convert nanoseconds to milliseconds
    const formatTimestamp = (timestamp: number) => {
      try {
        // Handle undefined/null timestamp
        if (!timestamp || isNaN(timestamp)) {
          return 'Invalid timestamp';
        }
        // Convert nanoseconds to milliseconds
        const date = new Date(timestamp / 1000000);
        if (isNaN(date.getTime())) {
          return 'Invalid date';
        }
        return date.toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
      } catch (error) {
        console.error('Timestamp formatting error:', error);
        return 'Error formatting timestamp';
      }
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

  // Decode Base64 payload using backend API
  useEffect(() => {
    const decodePayload = async () => {
      try {
        if (!packet.payload_base64 || typeof packet.payload_base64 !== 'string') {
          setDecodedPayload('No payload data');
          return;
        }
        
        const decoded = await ApiService.base64Decode(packet.payload_base64);
        setDecodedPayload(decoded);
      } catch (error) {
        setDecodedPayload(`Unable to decode payload: ${error}`);
      }
    };

    decodePayload();
  }, [packet.payload_base64]);

  // Protocol type mapping
  const getProtocolName = (type: number) => {
    try {
      if (type === undefined || type === null || isNaN(type)) {
        return 'Unknown';
      }
      const protocolMap: { [key: number]: string } = {
        0: 'Unknown',
        1: 'HttpRequest',
        2: 'Http2Request',
        3: 'HttpResponse',
        4: 'Http2Response',
        5: 'WebSocket'
      };
      return protocolMap[type] || `Unknown (${type})`;
    } catch (error) {
      console.error('Protocol name error:', error);
      return 'Error';
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
                    <span className="text-gray-500 dark:text-gray-400">UUID:</span>
                    <div className="font-mono text-xs">{packet.uuid || 'N/A'}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Protocol Type:</span>
                    <div className="font-semibold">{getProtocolName(packet.type)}</div>
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
                    <div className="font-mono">{packet.src_ip || 'N/A'}:{packet.src_port || 0}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Destination:</span>
                    <div className="font-mono">{packet.dst_ip || 'N/A'}:{packet.dst_port || 0}</div>
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
                    <div className="font-semibold">{packet.pname || 'N/A'}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Process ID:</span>
                    <div>{packet.pid !== undefined ? packet.pid : 'N/A'}</div>
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
                <div className="bg-gray-100 dark:bg-gray-900 rounded-md p-4 h-96 overflow-auto">
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
    console.error('DetailModal render error:', error);
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-red-600">Error Loading Packet</h2>
            <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md">
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
