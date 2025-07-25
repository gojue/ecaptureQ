import { useCallback } from 'react';
import { useAppState } from '@/hooks/useAppState';
import { PacketTable } from '@/components/PacketTable';
import { DetailModal } from '@/components/DetailModal';
import { Play, Square, Trash2, Loader2 } from 'lucide-react';
import type { PacketData } from '@/types';

interface CapturePageProps {
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

export function CapturePage({ appState: providedAppState }: CapturePageProps) {
  const localAppState = useAppState();
  const appState = providedAppState || localAppState;
  
  const {
    isCapturing,
    isLoading,
    packets,
    selectedPacket,
    startCapture,
    stopCapture,
    clearPackets,
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

  const handleClear = useCallback(() => {
    clearPackets();
  }, [clearPackets]);

  const handlePacketClick = useCallback((packet: typeof packets[0]) => {
    selectPacket(packet);
  }, [selectPacket]);

  const handleModalClose = useCallback(() => {
    selectPacket(null);
  }, [selectPacket]);

  return (
    <div className="h-full flex flex-col">
      {/* Control Bar */}
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              {/* Status Indicator */}
              <div className="flex items-center space-x-2">
                <div className={`w-3 h-3 rounded-full ${
                  isCapturing ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
                }`} />
                <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                  {isCapturing ? 'Capturing' : 'Stopped'}
                </span>
              </div>
              
              {/* Packet Count */}
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {packets.length.toLocaleString()} packets
              </span>
            </div>
            
            {/* Control Buttons */}
            <div className="flex items-center space-x-3">
              {packets.length > 0 && (
                <button
                  onClick={handleClear}
                  disabled={isLoading}
                  className="flex items-center space-x-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Trash2 size={16} />
                  <span>Clear</span>
                </button>
              )}
              
              <button
                onClick={isCapturing ? handleStop : handleStart}
                disabled={isLoading}
                className={`flex items-center space-x-2 px-6 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-75 disabled:cursor-wait ${
                  isCapturing
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-green-600 hover:bg-green-700 text-white'
                }`}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>{isCapturing ? 'Stopping...' : 'Starting...'}</span>
                  </>
                ) : (
                  <>
                    {isCapturing ? <Square size={16} /> : <Play size={16} />}
                    <span>{isCapturing ? 'Stop' : 'Start'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Packet Table */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <PacketTable
          packets={packets}
          onPacketClick={handlePacketClick}
        />
      </div>

      {/* Detail Modal */}
      <DetailModal
        packet={selectedPacket}
        onClose={handleModalClose}
      />
    </div>
  );
}
