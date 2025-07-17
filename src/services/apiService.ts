import { invoke } from '@tauri-apps/api/core';
import type { PacketData } from '@/types';

export class ApiService {
  /**
   * 启动后端的 eCapture 进程和 WebSocket 监听服务，开始捕获网络数据包
   */
  static async startCapture(): Promise<void> {
    try {
      await invoke('start_capture');
      console.log('捕获会话已成功启动！');
    } catch (error) {
      console.error('启动捕获失败:', error);
      throw error;
    }
  }

  /**
   * 停止 eCapture 进程和 WebSocket 监听，终止当前的捕获会话
   */
  static async stopCapture(): Promise<void> {
    try {
      await invoke('stop_capture');
      console.log('捕获会话已成功停止。');
    } catch (error) {
      console.error('停止捕获失败:', error);
      throw error;
    }
  }

  /**
   * 全量拉取所有数据包，用于初始化前端数据视图
   * 调用此接口会自动重置后端的增量更新偏移量
   */
  static async getAllData(): Promise<PacketData[]> {
    try {
      const packets: PacketData[] = await invoke('get_all_data');
      console.log(`成功拉取到 ${packets.length} 条初始数据。`);
      return packets;
    } catch (error) {
      console.error('全量拉取数据失败:', error);
      return [];
    }
  }

  /**
   * 增量获取自上次调用以来新捕获的数据包
   * 此接口设计用于轮询调用，以实现实时的数据流效果
   */
  static async getIncrementalData(): Promise<PacketData[]> {
    try {
      const newPackets: PacketData[] = await invoke('get_incremental_data');
      if (newPackets.length > 0) {
        console.log(`获取到 ${newPackets.length} 条新数据。`);
      }
      return newPackets;
    } catch (error) {
      console.error('增量拉取数据失败:', error);
      return [];
    }
  }
}
