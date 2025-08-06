import { useState, useCallback, useRef, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
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
  
  const unlistenRef = useRef<(() => void) | null>(null);

  // 设置事件监听
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupEventListener = async () => {
      try {
        unlisten = await listen<PacketData[]>('packet-data', (event) => {
          const newPackets = event.payload;
          if (newPackets.length > 0) {
            setPackets(prev => [...prev, ...newPackets]);
          }
        });
        unlistenRef.current = unlisten;
      } catch (error) {
        console.error('Failed to setup event listener:', error);
      }
    };

    if (isCapturing) {
      setupEventListener();
    }

    // 清理函数
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [isCapturing]);

  /**
   * 启动捕获会话
   * 1. 调用 start_capture API
   * 2. 设置事件监听状态（通过 isCapturing 状态变化触发 useEffect）
   */
  const startCapture = useCallback(async () => {
    if (isCapturing) return;
    
    setIsLoading(true);
    try {
      // 启动后端捕获服务
      await ApiService.startCapture();
      
      // 设置捕获状态为 true，这会触发 useEffect 设置事件监听
      setIsCapturing(true);

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
   * 2. 清除事件监听（通过 isCapturing 状态变化触发 useEffect 清理）
   */
  const stopCapture = useCallback(async () => {
    if (!isCapturing) return;
    
    setIsLoading(true);
    try {
      // 停止后端捕获服务
      await ApiService.stopCapture();
      
      // 设置捕获状态为 false，这会触发 useEffect 清除事件监听
      setIsCapturing(false);

      // 手动清除当前的事件监听器
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
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
