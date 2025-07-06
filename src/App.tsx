import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MainWindow } from '@/windows/MainWindow';
import { SettingsWindow } from '@/windows/SettingsWindow';

const windowComponents: Record<string, React.ComponentType> = {
  main: MainWindow,
  settings: SettingsWindow,
};

function App() {
  const [windowLabel, setWindowLabel] = useState<string>('main');

  useEffect(() => {
    const getWindowLabel = async () => {
      try {
        // 检查是否在移动端环境
        const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                         window.innerWidth <= 768;
        
        if (isMobile) {
          // 移动端根据 URL hash 决定显示哪个界面
          if (window.location.hash === '#settings') {
            setWindowLabel('settings');
          } else {
            setWindowLabel('main');
          }
          console.log('Mobile detected, window label:', window.location.hash === '#settings' ? 'settings' : 'main');
          return;
        }
        
        // 桌面平台使用 Tauri API
        if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
          try {
            const currentWindow = getCurrentWindow();
            const label = currentWindow.label;
            console.log('Desktop window label:', label);
            setWindowLabel(label || 'main');
          } catch (tauriError) {
            console.warn('Tauri API failed, using main window:', tauriError);
            setWindowLabel('main');
          }
        } else {
          // 浏览器环境，默认主窗口
          setWindowLabel('main');
        }
      } catch (error) {
        console.error('Failed to get window label:', error);
        setWindowLabel('main');
      }
    };

    getWindowLabel();
    
    // 监听 hash 变化（用于移动端导航）
    const handleHashChange = () => {
      const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                       window.innerWidth <= 768;
      if (isMobile) {
        if (window.location.hash === '#settings') {
          setWindowLabel('settings');
        } else {
          setWindowLabel('main');
        }
      }
    };
    
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const WindowComponent = windowComponents[windowLabel] || MainWindow;

  return <WindowComponent />;
}

export default App;
