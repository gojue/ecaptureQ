import { useState, useEffect } from 'react';

export type Platform = 'desktop' | 'mobile';

export function usePlatform() {
  const [currentPlatform, setPlatform] = useState<Platform>('desktop');

  useEffect(() => {
    let isMounted = true;
    
    // Detect platform using window.navigator
    const detectPlatform = () => {
      const userAgent = navigator.userAgent.toLowerCase();
      if (userAgent.includes('android') || userAgent.includes('iphone') || userAgent.includes('ipad')) {
        return 'mobile';
      }
      return 'desktop';
    };

    if (isMounted) {
      setPlatform(detectPlatform());
    }

    return () => { isMounted = false; };
  }, []);

  return currentPlatform;
}
