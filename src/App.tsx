import { useCallback } from 'react';
import { useAppState } from '@/hooks/useAppState';
import { Controls } from '@/components/Controls';
import { NewPacketList } from '@/components/NewPacketList';
import { DetailModal } from '@/components/DetailModal';

function App() {
  const {
    isCapturing,
    isLoading,
    packets,
    selectedPacket,
    startCapture,
    stopCapture,
    clearPackets,
    selectPacket,
  } = useAppState();

  const handleStart = useCallback(async () => {
    try {
      await startCapture();
    } catch (error) {
      console.error('Failed to start capture:', error);
      // 这里可以添加错误提示
    }
  }, [startCapture]);

  const handleStop = useCallback(async () => {
    try {
      await stopCapture();
    } catch (error) {
      console.error('Failed to stop capture:', error);
      // 这里可以添加错误提示
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
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* 控制栏 */}
      <Controls
        isCapturing={isCapturing}
        isLoading={isLoading}
        onStart={handleStart}
        onStop={handleStop}
        onClear={handleClear}
        packetCount={packets.length}
      />

      {/* 主内容区域 - 数据包列表 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <NewPacketList
          packets={packets}
          onPacketClick={handlePacketClick}
          showTimestamp={true}
          autoScroll={true}
        />
      </div>

      {/* 详情弹窗 */}
      <DetailModal
        packet={selectedPacket}
        onClose={handleModalClose}
      />
    </div>
  );
}

export default App;
