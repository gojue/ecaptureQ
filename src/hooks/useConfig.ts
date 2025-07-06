import { useState, useEffect, useCallback } from 'react';
import { load } from '@tauri-apps/plugin-store';
import type { AppConfig } from '@/types';

let store: any = null;

const defaultConfig: AppConfig = {
  websocketUrl: 'ws://localhost:8080/packets',
  theme: 'system',
  autoScroll: true,
  maxPackets: 1000,
  showTimestamp: true,
  showHeaders: true,
};

export function useConfig() {
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [loading, setLoading] = useState(true);

  // Initialize store and load configuration
  useEffect(() => {
    const initStore = async () => {
      try {
        store = await load('config.json', { autoSave: true });
        const savedConfig = await store.get('config') as AppConfig | null;
        if (savedConfig) {
          setConfig({ ...defaultConfig, ...savedConfig });
        }
      } catch (error) {
        console.error('Failed to load config:', error);
      } finally {
        setLoading(false);
      }
    };

    initStore();
  }, []);

  // Save configuration to store
  const updateConfig = useCallback(async (updates: Partial<AppConfig>) => {
    if (!store) return;
    
    const newConfig = { ...config, ...updates };
    setConfig(newConfig);
    
    try {
      await store.set('config', newConfig);
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }, [config]);

  // Get a specific config value
  const getConfigValue = useCallback(<K extends keyof AppConfig>(
    key: K,
    defaultValue?: AppConfig[K]
  ): AppConfig[K] => {
    return config[key] ?? defaultValue ?? defaultConfig[key];
  }, [config]);

  // Set a specific config value
  const setConfigValue = useCallback(<K extends keyof AppConfig>(
    key: K,
    value: AppConfig[K]
  ) => {
    updateConfig({ [key]: value });
  }, [updateConfig]);

  return {
    config,
    loading,
    updateConfig,
    getConfigValue,
    setConfigValue,
  };
}
