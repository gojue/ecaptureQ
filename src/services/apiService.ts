import { invoke } from '@tauri-apps/api/core';
import type { Configs } from '@/types';

export class ApiService {
  /**
   * Start eCapture process and WebSocket listener to begin capturing network packets
   */
  static async startCapture(): Promise<void> {
    try {
      await invoke('start_capture');
      console.log('Capture session started successfully');
    } catch (error) {
      console.error('Failed to start capture:', error);
      throw error;
    }
  }

  /**
   * Stop eCapture process and WebSocket listener
   */
  static async stopCapture(): Promise<void> {
    try {
      await invoke('stop_capture');
      console.log('Capture session stopped successfully');
    } catch (error) {
      console.error('Failed to stop capture:', error);
      throw error;
    }
  }

  /**
   * Get application configs
   */
  static async getConfigs(): Promise<Configs> {
    try {
      const configs: Configs = await invoke('get_configs');
      return configs;
    } catch (error) {
      console.error('Failed to get configs:', error);
      throw error;
    }
  }

  /**
   * Modify application configs
   */
  static async modifyConfigs(patch: Configs): Promise<void> {
    try {
      await invoke('modify_configs', { patch });
      console.log('Configs updated successfully');
    } catch (error) {
      console.error('Failed to update configs:', error);
      throw error;
    }
  }

  /**
   * Decode Base64 string
   */
  static async base64Decode(base64String: string): Promise<string> {
    try {
      const result: string = await invoke('base64_decode', { base64String: base64String });
      return result;
    } catch (error) {
      console.error('Base64 decode failed:', error);
      throw error;
    }
  }
}
