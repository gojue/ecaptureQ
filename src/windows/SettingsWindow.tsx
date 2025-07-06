import { useState, useEffect } from 'react';
import { Save, X, ArrowLeft } from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';
import { isMobile } from '@/utils/httpParser';
import type { AppConfig } from '@/types';

export function SettingsWindow() {
  const { config, updateConfig, loading } = useConfig();
  const [formData, setFormData] = useState<AppConfig>(config);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mobile, setMobile] = useState(false);

  // Check if mobile on mount and window resize
  useEffect(() => {
    const checkMobile = () => setMobile(isMobile());
    checkMobile();
    
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    setFormData(config);
  }, [config]);

  const handleInputChange = (key: keyof AppConfig, value: any) => {
    setFormData(prev => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateConfig(formData);
      setIsDirty(false);
    } catch (error) {
      console.error('Failed to save settings:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setFormData(config);
    setIsDirty(false);
  };

  const handleBack = () => {
    if (mobile) {
      window.location.hash = '';
    }
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {mobile && (
                <button
                  onClick={handleBack}
                  className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  <ArrowLeft className="h-5 w-5 text-gray-600 dark:text-gray-400" />
                </button>
              )}
              <h1 className="text-xl font-normal text-gray-900 dark:text-gray-100">
                Settings
              </h1>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto p-6">
          <div className="space-y-6">
            {/* Connection Settings */}
            <div className="card p-6">
              <h2 className="text-lg font-normal text-gray-900 dark:text-gray-100 mb-4">
                Connection Settings
              </h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-normal text-gray-700 dark:text-gray-300 mb-2">
                    WebSocket URL
                  </label>
                  <input
                    type="url"
                    value={formData.websocketUrl}
                    onChange={(e) => handleInputChange('websocketUrl', e.target.value)}
                    placeholder="ws://localhost:8080/packets"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-gray-100"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    The WebSocket endpoint to receive HTTP packet data from
                  </p>
                </div>
              </div>
            </div>

            {/* Display Settings */}
            <div className="card p-6">
              <h2 className="text-lg font-normal text-gray-900 dark:text-gray-100 mb-4">
                Display Settings
              </h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-normal text-gray-700 dark:text-gray-300 mb-2">
                    Theme
                  </label>
                  <select
                    value={formData.theme}
                    onChange={(e) => handleInputChange('theme', e.target.value as 'light' | 'dark' | 'system')}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-gray-100"
                  >
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="system">System</option>
                  </select>
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="showTimestamp"
                    checked={formData.showTimestamp}
                    onChange={(e) => handleInputChange('showTimestamp', e.target.checked)}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label htmlFor="showTimestamp" className="ml-2 block text-sm text-gray-700 dark:text-gray-300">
                    Show timestamps
                  </label>
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="showHeaders"
                    checked={formData.showHeaders}
                    onChange={(e) => handleInputChange('showHeaders', e.target.checked)}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label htmlFor="showHeaders" className="ml-2 block text-sm text-gray-700 dark:text-gray-300">
                    Show headers by default
                  </label>
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="autoScroll"
                    checked={formData.autoScroll}
                    onChange={(e) => handleInputChange('autoScroll', e.target.checked)}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label htmlFor="autoScroll" className="ml-2 block text-sm text-gray-700 dark:text-gray-300">
                    Auto-scroll to new packets
                  </label>
                </div>
              </div>
            </div>

            {/* Performance Settings */}
            <div className="card p-6">
              <h2 className="text-lg font-normal text-gray-900 dark:text-gray-100 mb-4">
                Performance Settings
              </h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-normal text-gray-700 dark:text-gray-300 mb-2">
                    Maximum packets to keep in memory
                  </label>
                  <input
                    type="number"
                    min="100"
                    max="10000"
                    step="100"
                    value={formData.maxPackets}
                    onChange={(e) => handleInputChange('maxPackets', parseInt(e.target.value) || 1000)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-gray-100"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Older packets will be automatically removed to prevent memory issues
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {isDirty && 'You have unsaved changes'}
          </div>
          
          <div className="flex items-center space-x-3">
            {isDirty && (
              <button
                onClick={handleReset}
                className="btn-secondary flex items-center space-x-2"
              >
                <X className="h-4 w-4" />
                <span>Reset</span>
              </button>
            )}
            
            <button
              onClick={handleSave}
              disabled={!isDirty || saving}
              className="btn-primary flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="h-4 w-4" />
              <span>{saving ? 'Saving...' : 'Save'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
