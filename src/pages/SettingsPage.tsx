import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { usePlatform } from '@/hooks/usePlatform';

export function SettingsPage() {
  const navigate = useNavigate();
  const platform = usePlatform();

  return (
    <div className="h-full flex flex-col">
      {platform === 'mobile' && (
        <div className="flex items-center p-4 border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => navigate('/')}
            className="flex items-center space-x-2 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
          >
            <ArrowLeft size={20} />
            <span>Back</span>
          </button>
        </div>
      )}
      
      <div className="flex-1 p-8">
        <h2 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-gray-100">Settings</h2>
        <p className="text-gray-600 dark:text-gray-400">
          Configuration options will be available here in a future update.
        </p>
      </div>
    </div>
  );
}
