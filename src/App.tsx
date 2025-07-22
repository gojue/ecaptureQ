import { usePlatform } from '@/hooks/usePlatform';
import { DesktopApp } from '@/layouts/DesktopApp';
import { MobileApp } from '@/layouts/MobileApp';

function App() {
  const platform = usePlatform();

  if (platform === 'mobile') {
    return <MobileApp />;
  }
  
  return <DesktopApp />;
}

export default App;
