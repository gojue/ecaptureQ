import { useState } from 'react';
import { X, Copy, Code, FileText, Globe } from 'lucide-react';
import type { HttpPacket } from '@/types';
import { 
  formatTimestamp, 
  formatSize, 
  getMethodColorClass, 
  getStatusColorClass,
  decodeBase64
} from '@/utils/httpParser';

interface PacketDetailModalProps {
  packet: HttpPacket | null;
  isOpen: boolean;
  onClose: () => void;
  isMobile: boolean;
}

type TabType = 'overview' | 'headers' | 'body' | 'raw';

export function PacketDetailModal({ packet, isOpen, onClose, isMobile }: PacketDetailModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  if (!isOpen || !packet) return null;

  const methodClass = getMethodColorClass(packet.method);
  const statusClass = packet.statusCode ? getStatusColorClass(packet.statusCode) : '';

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  const formatJson = (text: string): string => {
    try {
      const parsed = JSON.parse(text);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return text;
    }
  };

  const rawData = decodeBase64(packet.rawData);

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h4 className="text-sm font-normal text-gray-700 dark:text-gray-300 mb-2">Request Info</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center space-x-2">
                    <span className="text-gray-500 dark:text-gray-400">Method:</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-normal ${methodClass}`}>
                      {packet.method}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">URL:</span>
                    <p className="mt-1 break-all text-gray-900 dark:text-gray-100">{packet.url || 'No URL'}</p>
                  </div>
                  {packet.statusCode && (
                    <div className="flex items-center space-x-2">
                      <span className="text-gray-500 dark:text-gray-400">Status:</span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-normal ${statusClass}`}>
                        {packet.statusCode}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              
              <div>
                <h4 className="text-sm font-normal text-gray-700 dark:text-gray-300 mb-2">Technical Info</h4>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Timestamp:</span>
                    <p className="text-gray-900 dark:text-gray-100">{formatTimestamp(packet.timestamp)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Size:</span>
                    <p className="text-gray-900 dark:text-gray-100">{formatSize(packet.size)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Direction:</span>
                    <p className="text-gray-900 dark:text-gray-100 capitalize">{packet.direction}</p>
                  </div>
                  {packet.duration && (
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">Duration:</span>
                      <p className="text-gray-900 dark:text-gray-100">{packet.duration}ms</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );

      case 'headers':
        return (
          <div className="space-y-2">
            {Object.entries(packet.headers).length > 0 ? (
              Object.entries(packet.headers).map(([key, value]) => (
                <div key={key} className="border-b border-gray-200 dark:border-gray-700 pb-2">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-normal text-gray-900 dark:text-gray-100">{key}</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400 break-all">{value}</p>
                    </div>
                    <button
                      onClick={() => copyToClipboard(`${key}: ${value}`)}
                      className="ml-2 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-gray-500 dark:text-gray-400 text-center py-4">No headers available</p>
            )}
          </div>
        );

      case 'body':
        return (
          <div className="space-y-2">
            {packet.body ? (
              <div className="relative">
                <button
                  onClick={() => copyToClipboard(packet.body!)}
                  className="absolute top-2 right-2 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  <Copy className="h-4 w-4" />
                </button>
                <pre className="bg-gray-50 dark:bg-gray-900 p-4 rounded-md text-sm overflow-auto max-h-96 text-gray-900 dark:text-gray-100">
                  {formatJson(packet.body)}
                </pre>
              </div>
            ) : (
              <p className="text-gray-500 dark:text-gray-400 text-center py-4">No body content</p>
            )}
          </div>
        );

      case 'raw':
        return (
          <div className="space-y-2">
            <div className="relative">
              <button
                onClick={() => copyToClipboard(rawData)}
                className="absolute top-2 right-2 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 z-10"
              >
                <Copy className="h-4 w-4" />
              </button>
              <pre className="bg-gray-50 dark:bg-gray-900 p-4 rounded-md text-xs overflow-auto max-h-96 text-gray-900 dark:text-gray-100 font-mono">
                {rawData}
              </pre>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Background overlay */}
        <div 
          className="fixed inset-0 bg-gray-500 dark:bg-gray-900 bg-opacity-75 dark:bg-opacity-75 transition-opacity"
          onClick={onClose}
        />

        {/* Modal panel */}
        <div className={`
          inline-block align-bottom bg-white dark:bg-gray-800 rounded-lg text-left overflow-hidden shadow-xl transform transition-all
          ${isMobile ? 'w-full h-full' : 'sm:my-8 sm:align-middle sm:max-w-4xl sm:w-full max-h-[90vh]'}
        `}>
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-normal text-gray-900 dark:text-gray-100">
                Packet Details
              </h3>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-gray-200 dark:border-gray-700">
            <nav className="-mb-px flex space-x-8 px-6">
              {[
                { id: 'overview', name: 'Overview', icon: Globe },
                { id: 'headers', name: 'Headers', icon: FileText },
                { id: 'body', name: 'Body', icon: Code },
                { id: 'raw', name: 'Raw', icon: FileText },
              ].map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as TabType)}
                    className={`
                      flex items-center space-x-2 py-4 px-1 border-b-2 font-normal text-sm
                      ${activeTab === tab.id
                        ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                        : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                      }
                    `}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{tab.name}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Content */}
          <div className={`px-6 py-4 overflow-auto ${isMobile ? 'max-h-[70vh]' : 'max-h-96'}`}>
            {renderTabContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
