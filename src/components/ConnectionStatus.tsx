import { Wifi, WifiOff, Settings } from 'lucide-react';

interface ConnectionStatusProps {
  isConnected: boolean;
  websocketUrl: string;
  onReconnect: () => void;
  onOpenSettings: () => void;
  isMobile: boolean;
}

export function ConnectionStatus({ 
  isConnected, 
  websocketUrl, 
  onReconnect, 
  onOpenSettings,
  isMobile 
}: ConnectionStatusProps) {
  return (
    <div className={`flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 ${isMobile ? 'flex-col space-y-2' : ''}`}>
      <div className={`flex items-center space-x-3 ${isMobile ? 'w-full justify-center' : ''}`}>
        {isConnected ? (
          <Wifi className="h-5 w-5 text-green-500" />
        ) : (
          <WifiOff className="h-5 w-5 text-red-500" />
        )}
        
        <div className={`${isMobile ? 'text-center' : ''}`}>
          <p className={`text-sm font-normal ${isConnected ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs">
            {websocketUrl}
          </p>
        </div>
      </div>
      
      <div className={`flex items-center space-x-2 ${isMobile ? 'w-full justify-center' : ''}`}>
        {!isConnected && (
          <button
            onClick={onReconnect}
            className="btn-primary text-sm px-3 py-1"
          >
            Reconnect
          </button>
        )}
        
        <button
          onClick={onOpenSettings}
          className="btn-secondary text-sm px-3 py-1 flex items-center space-x-1"
        >
          <Settings className="h-4 w-4" />
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}
