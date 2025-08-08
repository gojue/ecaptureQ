import { useState, useEffect, useCallback } from 'react';
import { ApiService } from '@/services/apiService';
import type { Configs } from '@/types';

export function useConfigs() {
  const [configs, setConfigs] = useState<Configs>({});
  const [isLoading, setIsLoading] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [originalConfigs, setOriginalConfigs] = useState<Configs>({});

  // 加载配置
  const loadConfigs = useCallback(async () => {
    setIsLoading(true);
    try {
      const loadedConfigs = await ApiService.getConfigs();
      setConfigs(loadedConfigs);
      setOriginalConfigs(loadedConfigs);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to load configs:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 更新配置
  const updateConfigs = useCallback((patch: Partial<Configs>) => {
    setConfigs(prev => {
      const newConfigs = { ...prev, ...patch };
      setHasChanges(JSON.stringify(newConfigs) !== JSON.stringify(originalConfigs));
      return newConfigs;
    });
  }, [originalConfigs]);

  // 保存配置
  const saveConfigs = useCallback(async () => {
    if (!hasChanges) return;
    
    setIsLoading(true);
    try {
      // 只发送改变的字段
      const patch: Configs = {};
      if (configs.ws_url !== originalConfigs.ws_url) {
        patch.ws_url = configs.ws_url;
      }
      if (configs.ecapture_args !== originalConfigs.ecapture_args) {
        patch.ecapture_args = configs.ecapture_args;
      }
      
      await ApiService.modifyConfigs(patch);
      setOriginalConfigs(configs);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to save configs:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [configs, originalConfigs, hasChanges]);

  // 重置配置
  const resetConfigs = useCallback(() => {
    setConfigs(originalConfigs);
    setHasChanges(false);
  }, [originalConfigs]);

  // 初始加载
  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  return {
    configs,
    isLoading,
    hasChanges,
    updateConfigs,
    saveConfigs,
    resetConfigs,
    reloadConfigs: loadConfigs,
  };
}
