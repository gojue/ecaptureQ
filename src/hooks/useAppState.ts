import { useState, useCallback, useRef } from 'react';
import { ApiService } from '@/services/apiService';
import type { PacketData } from '@/types';

export interface AppState {
  isCapturing: boolean;
  isLoading: boolean;
  packets: PacketData[];
  selectedPacket: PacketData | null;
}

export function useAppState() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [packets, setPackets] = useState<PacketData[]>([]);
  const [selectedPacket, setSelectedPacket] = useState<PacketData | null>(null);
  
  const pollingIntervalRef = useRef<number | null>(null);

  /**
   * 启动捕获会话
   * 1. 调用 start_capture API
   * 2. 全量加载初始数据
   * 3. 启动定时轮询获取增量数据
   */
  const startCapture = useCallback(async () => {
    if (isCapturing) return;
    
    setIsLoading(true);
    try {
      // 启动后端捕获服务
      await ApiService.startCapture();
      setIsCapturing(true);

      // 立即进行全量加载
      const initialData = await ApiService.getAllData();
      setPackets(initialData);

      // 启动轮询 - 每 500ms 获取增量数据
      pollingIntervalRef.current = window.setInterval(async () => {
        try {
          const newPackets = await ApiService.getIncrementalData();
          if (newPackets.length > 0) {
            setPackets(prev => [...prev, ...newPackets]);
          }
        } catch (error) {
          console.error('轮询获取数据失败:', error);
        }
      }, 500);

    } catch (error) {
      console.error("启动流程出错:", error);
      setIsCapturing(false);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [isCapturing]);

  /**
   * 停止捕获会话
   * 1. 调用 stop_capture API
   * 2. 清除定时轮询
   */
  const stopCapture = useCallback(async () => {
    if (!isCapturing) return;
    
    setIsLoading(true);
    try {
      // 停止后端捕获服务
      await ApiService.stopCapture();
      setIsCapturing(false);

      // 清除定时器
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    } catch (error) {
      console.error("停止流程出错:", error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [isCapturing]);

  /**
   * 清空数据包列表
   */
  const clearPackets = useCallback(() => {
    setPackets([]);
  }, []);

  /**
   * 选择数据包查看详情
   */
  const selectPacket = useCallback((packet: PacketData | null) => {
    setSelectedPacket(packet);
  }, []);

  return {
    // 状态
    isCapturing,
    isLoading,
    packets,
    selectedPacket,
    
    // 操作方法
    startCapture,
    stopCapture,
    clearPackets,
    selectPacket,
  };
}
