import { useCallback } from 'react';
import { useAppState } from '@/hooks/useAppState';
import { NewPacketList } from '@/components/NewPacketList';
import { DetailModal } from '@/components/DetailModal';
import { Play, Square, Loader2 } from 'lucide-react';
import type { PacketData } from '@/types';

interface CapturePageMobileProps {
  appState?: {
    isCapturing: boolean;
    isLoading: boolean;
    packets: PacketData[];
    selectedPacket: PacketData | null;
    startCapture: () => Promise<void>;
    stopCapture: () => Promise<void>;
    clearPackets: () => void;
    selectPacket: (packet: PacketData | null) => void;
  };
}

export function CapturePageMobile({ appState: providedAppState }: CapturePageMobileProps) {
  const localAppState = useAppState();
  const appState = providedAppState || localAppState;
  
  const {
    isCapturing,
    isLoading,
    packets,
    selectedPacket,
    startCapture,
    stopCapture,
    selectPacket,
  } = appState;

  const handleStart = useCallback(async () => {
    try {
      await startCapture();
    } catch (error) {
      console.error('Failed to start capture:', error);
    }
  }, [startCapture]);

  const handleStop = useCallback(async () => {
    try {
      await stopCapture();
    } catch (error) {
      console.error('Failed to stop capture:', error);
    }
  }, [stopCapture]);

  const handlePacketClick = useCallback((packet: typeof packets[0]) => {
    selectPacket(packet);
  }, [selectPacket]);

  const handleModalClose = useCallback(() => {
    selectPacket(null);
  }, [selectPacket]);

  return (
    <div className="relative flex flex-col h-full">
      {/* Packet List */}
      <div className="flex-1 overflow-hidden">
        <NewPacketList
          packets={packets}
          onPacketClick={handlePacketClick}
          showTimestamp={true}
          autoScroll={true}
        />
      </div>
      
      {/* Detail Modal */}
      <DetailModal 
        packet={selectedPacket} 
        onClose={handleModalClose} 
      />
      
      {/* Floating Action Button (FAB) */}
      <div className="absolute bottom-6 right-6 z-20">
        <button
          onClick={isCapturing ? handleStop : handleStart}
          disabled={isLoading}
          className="w-14 h-14 rounded-full flex items-center justify-center text-white shadow-lg transition-all duration-300 disabled:opacity-75 disabled:cursor-wait focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
          style={{
            background: isCapturing 
              ? 'linear-gradient(135deg, #ef4444, #dc2626)' 
              : 'linear-gradient(135deg, #10b981, #059669)'
          }}
        >
          {isLoading ? (
            <Loader2 className="w-6 h-6 animate-spin" />
          ) : isCapturing ? (
            <Square className="w-6 h-6" />
          ) : (
            <Play className="w-6 h-6" />
          )}
        </button>
      </div>
    </div>
  );
}
