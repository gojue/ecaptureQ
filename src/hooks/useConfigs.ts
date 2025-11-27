import { useState, useEffect, useCallback } from "react";
import { ApiService } from "@/services/apiService";
import type { Configs } from "@/types";

export function useConfigs() {
  const [configs, setConfigs] = useState<Configs>({});
  const [isLoading, setIsLoading] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [originalConfigs, setOriginalConfigs] = useState<Configs>({});

  const loadConfigs = useCallback(async () => {
    setIsLoading(true);
    try {
      const loadedConfigs = await ApiService.getConfigs();
      setConfigs(loadedConfigs);
      setOriginalConfigs(loadedConfigs);
      setHasChanges(false);
    } catch (error) {
      console.error("Failed to load configs:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const updateConfigs = useCallback(
    (patch: Partial<Configs>) => {
      setConfigs((prev) => {
        const newConfigs = { ...prev, ...patch };
        setHasChanges(
          JSON.stringify(newConfigs) !== JSON.stringify(originalConfigs),
        );
        return newConfigs;
      });
    },
    [originalConfigs],
  );

  const saveConfigs = useCallback(async () => {
    if (!hasChanges) return;

    setIsLoading(true);
    try {
      const userSqlChanged = configs.user_sql !== originalConfigs.user_sql;
      if (userSqlChanged) {
        // Validate SQL before saving
        await ApiService.verifyUserSql(configs.user_sql ?? null);
      }

      await ApiService.modifyConfigs(configs);
      setOriginalConfigs(configs);
      setHasChanges(false);
    } catch (error) {
      console.error("Failed to save configs:", error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [configs, originalConfigs, hasChanges]);

  const resetConfigs = useCallback(() => {
    setConfigs(originalConfigs);
    setHasChanges(false);
  }, [originalConfigs]);

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
