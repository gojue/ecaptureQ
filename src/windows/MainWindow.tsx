import { useState, useEffect, useCallback } from 'react';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { PacketList } from '@/components/PacketList';
import { WebSocketService } from '@/services/websocketService';
import { useConfig } from '@/hooks/useConfig';
import type { HttpPacket } from '@/types';
import { isMobile } from '@/utils/httpParser';

export function MainWindow() {
  const { config, getConfigValue } = useConfig();
  const [packets, setPackets] = useState<HttpPacket[]>([]);
  const [wsService, setWsService] = useState<WebSocketService | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [mobile, setMobile] = useState(false);

  // Check if mobile on mount and window resize
  useEffect(() => {
    const checkMobile = () => setMobile(isMobile());
    checkMobile();
    
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Handle new packets
  const handleNewPacket = useCallback((packet: HttpPacket) => {
    setPackets(prev => {
      const maxPackets = getConfigValue('maxPackets', 1000);
      const newPackets = [...prev, packet];
      
      // Keep only the most recent packets
      if (newPackets.length > maxPackets) {
        return newPackets.slice(-maxPackets);
      }
      
      return newPackets;
    });
  }, [getConfigValue]);

  // Initialize WebSocket connection
  useEffect(() => {
    const websocketUrl = getConfigValue('websocketUrl');
    if (!websocketUrl) return;

    const service = new WebSocketService(websocketUrl);
    
    service.addPacketListener(handleNewPacket);
    
    // Connect to WebSocket
    service.connect()
      .then(() => {
        setIsConnected(true);
        setWsService(service);
      })
      .catch((error) => {
        console.error('Failed to connect:', error);
        setIsConnected(false);
      });

    return () => {
      service.removePacketListener(handleNewPacket);
      service.disconnect();
    };
  }, [config.websocketUrl, handleNewPacket, getConfigValue]);

  const handleReconnect = async () => {
    if (wsService) {
      try {
        await wsService.disconnect();
        await wsService.connect();
        setIsConnected(true);
      } catch (error) {
        console.error('Failed to reconnect:', error);
        setIsConnected(false);
      }
    }
  };

  const handleOpenSettings = async () => {
    // 在移动端使用 hash 路由，在桌面端打开新窗口
    if (mobile) {
      window.location.hash = '#settings';
    } else {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_settings_window');
      } catch (error) {
        console.error('Failed to open settings window:', error);
      }
    }
  };

  const clearPackets = () => {
    setPackets([]);
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-normal text-gray-900 dark:text-gray-100">
              EcaptureQ
            </h1>
            
            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {packets.length} packets
              </span>
              
              {packets.length > 0 && (
                <button
                  onClick={clearPackets}
                  className="btn-secondary text-sm px-3 py-1"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>

        <ConnectionStatus
          isConnected={isConnected}
          websocketUrl={getConfigValue('websocketUrl')}
          onReconnect={handleReconnect}
          onOpenSettings={handleOpenSettings}
          isMobile={mobile}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <PacketList
          packets={packets}
          showTimestamp={getConfigValue('showTimestamp', true)}
          autoScroll={getConfigValue('autoScroll', true)}
        />
      </div>

      {/* Footer - Mobile only */}
      {mobile && (
        <div className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 p-2">
          <div className="flex justify-center">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Tap any packet to view details
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
