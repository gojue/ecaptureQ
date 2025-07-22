import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { CapturePageMobile } from '@/pages/CapturePageMobile';
import { SettingsPage } from '@/pages/SettingsPage';
import { Settings, Trash2 } from 'lucide-react';
import { useAppState } from '@/hooks/useAppState';
import { useCallback } from 'react';

export function MobileApp() {
  const navigate = useNavigate();
  const location = useLocation();
  const appState = useAppState();
  const { clearPackets, packets } = appState;
  
  const handleClear = useCallback(() => {
    clearPackets();
  }, [clearPackets]);

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
          <Route path="/" element={<CapturePageMobile appState={appState} />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
