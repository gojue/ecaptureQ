import { Play, Square, Trash2, Loader2 } from 'lucide-react';

interface ControlsProps {
  isCapturing: boolean;
  isLoading: boolean;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  packetCount: number;
}

export function Controls({
  isCapturing,
  isLoading,
  onStart,
  onStop,
  onClear,
  packetCount
}: ControlsProps) {
  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between">
          {/* 应用标题 */}
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            ecaptureQ
          </h1>
          
          <div className="flex items-center space-x-4">
            {/* 数据包计数 */}
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {packetCount.toLocaleString()} packets
            </span>
            
            {/* 状态指示器 */}
            <div className="flex items-center space-x-2">
              <div className={`w-2 h-2 rounded-full ${
                isCapturing ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
              }`} />
              <span className="text-sm text-gray-600 dark:text-gray-300">
                {isCapturing ? 'Running' : 'Stopped'}
              </span>
            </div>
            
            {/* 控制按钮组 */}
            <div className="flex items-center space-x-2">
              {/* 清空数据按钮 */}
              {packetCount > 0 && (
                <button
                  onClick={onClear}
                  disabled={isLoading}
                  className="flex items-center space-x-1 px-3 py-1 text-sm text-gray-600 dark:text-gray-300 
                           hover:text-gray-800 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 
                           rounded-md transition-colors disabled:opacity-50"
                  title="Clear all packets"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Clear</span>
                </button>
              )}
              
              {/* 开始/停止按钮 */}
              {!isCapturing ? (
                <button
                  onClick={onStart}
                  disabled={isLoading}
                  className="flex items-center space-x-2 px-4 py-2 bg-green-600 hover:bg-green-700 
                           text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  <span>Start Capture</span>
                </button>
              ) : (
                <button
                  onClick={onStop}
                  disabled={isLoading}
                  className="flex items-center space-x-2 px-4 py-2 bg-red-600 hover:bg-red-700 
                           text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Square className="w-4 h-4" />
                  )}
                  <span>Stop Capture</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
