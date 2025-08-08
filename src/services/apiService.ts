import { invoke } from '@tauri-apps/api/core';
import type { Configs } from '@/types';

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
   * 获取应用配置
   */
  static async getConfigs(): Promise<Configs> {
    try {
      const configs: Configs = await invoke('get_configs');
      return configs;
    } catch (error) {
      console.error('获取配置失败:', error);
      throw error;
    }
  }

  /**
   * 修改应用配置
   */
  static async modifyConfigs(patch: Configs): Promise<void> {
    try {
      await invoke('modify_configs', { patch });
      console.log('配置已成功更新。');
    } catch (error) {
      console.error('更新配置失败:', error);
      throw error;
    }
  }
}
