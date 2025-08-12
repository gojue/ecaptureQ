import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { CapturePage } from '@/pages/CapturePage';
import { SettingsPage } from '@/pages/SettingsPage';
import { Wifi, Settings, Trash2 } from 'lucide-react';
import { useAppState } from '@/hooks/useAppState';
import { useResponsive } from '@/hooks/useResponsive';
import { useCallback } from 'react';

export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const appState = useAppState();
  const { isMobile } = useResponsive();
  const { clearPackets, packets } = appState;

  const isActive = (path: string) => location.pathname === path;
  
  const handleClear = useCallback(() => {
    clearPackets();
  }, [clearPackets]);

  if (isMobile) {
    // Mobile Layout
    return (
      <div className="h-screen flex flex-col bg-gray-100 dark:bg-gray-900">
        {/* Top App Bar - only show on capture page */}
        {location.pathname === '/' && (
          <header className="bg-white dark:bg-gray-800 shadow-md h-16 flex items-center justify-between px-4 z-10 flex-shrink-0">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">ecaptureQ</h1>
            <div className="flex items-center space-x-2">
              {packets.length > 0 && (
                <button 
                  onClick={handleClear} 
                  className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
                >
                  <Trash2 size={20} />
                </button>
              )}
              <button 
                onClick={() => navigate('/settings')} 
                className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
              >
                <Settings size={20} />
              </button>
            </div>
          </header>
        )}

        {/* Main Content */}
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<CapturePage appState={appState} />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    );
  }

  // Desktop Layout
  return (
    <div className="h-screen flex bg-gray-100 dark:bg-gray-900">
      {/* Sidebar Navigation */}
      <aside className="w-56 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">ecaptureQ</h1>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          <Link 
            to="/" 
            className={`flex items-center space-x-3 px-3 py-2 rounded-md transition-colors ${
              isActive('/') 
                ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300' 
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <Wifi size={20} />
            <span>Capture</span>
          </Link>
          <Link 
            to="/settings" 
            className={`flex items-center space-x-3 px-3 py-2 rounded-md transition-colors ${
              isActive('/settings') 
                ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300' 
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <Settings size={20} />
            <span>Settings</span>
          </Link>
        </nav>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col">
        <Routes>
          <Route path="/" element={<CapturePage appState={appState} />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
