import { ArrowLeft, Save, RotateCcw, Loader2, Server, Terminal, Github, Filter } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useResponsive } from '@/hooks/useResponsive';
import { useConfigs } from '@/hooks/useConfigs';
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-shell';

export function SettingsPage() {
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
  const { configs, isLoading, hasChanges, updateConfigs, saveConfigs, resetConfigs } = useConfigs();
  const [saveLoading, setSaveLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSave = async () => {
    if (!hasChanges) return;
    
    setSaveLoading(true);
    try {
      await saveConfigs();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaveLoading(false);
    }
  };

  const handleReset = () => {
    resetConfigs();
  };

  // Handle GitHub link click - open in system default browser
  const handleGitHubClick = async () => {
    await open('https://github.com/gojue/ecaptureQ');
  };  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center space-x-2 text-gray-500 dark:text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Loading settings...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-auto">
      {isMobile && (
        <div className="flex items-center p-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 sticky top-0 z-10">
          <button
            onClick={() => navigate('/')}
            className="flex items-center space-x-2 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
          >
            <ArrowLeft size={20} />
            <span>Back</span>
          </button>
        </div>
      )}
      
      <div className="flex-1 p-8 max-w-4xl mx-auto w-full">
        {/* GitHub Repository Link */}
        <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <Github className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              <div>
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  ecaptureQ Repository
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Source code, documentation, and issue tracking
                </p>
              </div>
            </div>
            <button
              onClick={handleGitHubClick}
              className="flex items-center space-x-2 px-3 py-2 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-md transition-colors"
            >
              <span className="text-sm">Visit GitHub</span>
              <Github className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Settings</h2>
          
          {hasChanges && (
            <div className="flex items-center space-x-3">
              <button
                onClick={handleReset}
                disabled={saveLoading}
                className="flex items-center space-x-2 px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-md transition-colors"
              >
                <RotateCcw size={16} />
                <span>Reset</span>
              </button>
              
              <button
                onClick={handleSave}
                disabled={saveLoading}
                className="flex items-center space-x-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-md transition-colors"
              >
                {saveLoading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <Save size={16} />
                    <span>Save Changes</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {errorMessage && (
          <div className="mb-6 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-300">
            {errorMessage}
          </div>
        )}

        <div className="space-y-6">
          {/* WebSocket Configuration */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
            <div className="flex items-center space-x-3 mb-4">
              <div className="p-2 bg-blue-100 dark:bg-blue-900/50 rounded-lg">
                <Server className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  WebSocket Server
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Configure the WebSocket server address for packet data reception
                </p>
              </div>
            </div>
            
            <div className="space-y-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Server URL
              </label>
              <input
                type="text"
                value={configs.ws_url || ''}
                onChange={(e) => updateConfigs({ ws_url: e.target.value })}
                placeholder="ws://127.0.0.1:28257"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Default: ws://127.0.0.1:28257 (leave empty to use default)
              </p>
            </div>
          </div>

          {/* eCapture Arguments */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
            <div className="flex items-center space-x-3 mb-4">
              <div className="p-2 bg-green-100 dark:bg-green-900/50 rounded-lg">
                <Terminal className="w-5 h-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  eCapture Arguments
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Additional command line arguments for the eCapture process
                </p>
              </div>
            </div>
            
            <div className="space-y-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Command Arguments
              </label>
              <textarea
                value={configs.ecapture_args || ''}
                onChange={(e) => updateConfigs({ ecapture_args: e.target.value })}
                placeholder="--interface=eth0 --port=8080"
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 font-mono text-sm"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Optional: Additional arguments to pass to the eCapture binary
              </p>
            </div>
          </div>

          {/* SQL Filter */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
            <div className="flex items-center space-x-3 mb-4">
              <div className="p-2 bg-purple-100 dark:bg-purple-900/40 rounded-lg">
                <Filter className="w-5 h-5 text-purple-600 dark:text-purple-300" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Packet SQL Filter
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  (Optional) Provide a custom SQL clause executed on the packet stream
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                SQL Query
              </label>
              <textarea
                value={configs.user_sql || ''}
                onChange={(e) => updateConfigs({ user_sql: e.target.value })}
                placeholder={`SELECT index, timestamp, src_ip, dst_ip, dst_port, pname, length, is_binary\nFROM packets\nWHERE dst_port = 443`}
                rows={6}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 font-mono text-sm"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                <span className="block">• Leave empty to stream all packets.</span>
                <span className="block">• SQL will be validated against an empty schema before saving.</span>
                <span className="block">• Must select the <code className="font-mono">index</code> column for incremental updates.</span>
              </p>
            </div>
          </div>

          {/* Information Section */}
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 p-4">
            <h4 className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-2">
              Configuration Notes
            </h4>
            <ul className="text-sm text-blue-700 dark:text-blue-400 space-y-1">
              <li>• Changes take effect after restarting the capture session</li>
              <li>• WebSocket URL should match your eCapture server configuration</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
