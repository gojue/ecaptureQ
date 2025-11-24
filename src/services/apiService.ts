import { invoke } from '@tauri-apps/api/core';
import type { Configs, PacketDataWithPayload } from '@/types';

export class ApiService {
  static async startCapture(): Promise<void> {
    try {
      await invoke('start_capture');
      console.log('Capture session started successfully');
    } catch (error) {
      console.error('Failed to start capture:', error);
      throw error;
    }
  }

  static async stopCapture(): Promise<void> {
    try {
      await invoke('stop_capture');
      console.log('Capture session stopped successfully');
    } catch (error) {
      console.error('Failed to stop capture:', error);
      throw error;
    }
  }

  static async getConfigs(): Promise<Configs> {
    try {
      const configs: Configs = await invoke('get_configs');
      return configs;
    } catch (error) {
      console.error('Failed to get configs:', error);
      throw error;
    }
  }

  static async verifyUserSql(userSql: string | null): Promise<void> {
    try {
      await invoke('verify_user_sql', { user_sql: userSql });
      console.log('User SQL verified successfully');
    } catch (error) {
      console.error('Failed to verify user SQL:', error);
      throw error;
    }
  }

  static async modifyConfigs(newConfigs: Configs): Promise<void> {
    try {
      await invoke('modify_configs', { newConfigs: newConfigs });
      console.log('Configs updated successfully');
    } catch (error) {
      console.error('Failed to update configs:', error);
      throw error;
    }
  }

  static async getPacketWithPayload(index: number): Promise<PacketDataWithPayload> {
    try {
      const result = await invoke('get_packet_with_payload', { index });
      return result as PacketDataWithPayload;
    } catch (error) {
      console.error('Failed to get packet with payload:', error);
      throw error;
    }
  }
}
