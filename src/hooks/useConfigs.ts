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
      // 检查是否有user_sql变更需要验证
      const userSqlChanged = configs.user_sql !== originalConfigs.user_sql;
      if (userSqlChanged) {
        // 如果user_sql有变更，先进行验证（后端会处理空值情况）
        await ApiService.verifyUserSql(configs.user_sql ?? null);
      }

      // 验证通过后，传递完整配置进行保存
      await ApiService.modifyConfigs(configs);
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
