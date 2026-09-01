import { AppShell } from '../components/AppShell';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ReaderRoutes, WorkspaceRoutes } from './routes';
import { PreferencesProvider } from './preferences';
import { startTagTranslationUpdates, stopTagTranslationUpdates } from '../lib/tagTranslationService';
import { ToastProvider } from '../components/Toast';

export function App() {
  const { pathname } = useLocation();
  useEffect(() => {
    const updateLifecycle = () => {
      if (document.visibilityState === 'hidden') stopTagTranslationUpdates();
      else startTagTranslationUpdates();
    };
    updateLifecycle();
    document.addEventListener('visibilitychange', updateLifecycle);
    return () => {
      document.removeEventListener('visibilitychange', updateLifecycle);
      stopTagTranslationUpdates();
    };
  }, []);
  return (
    <PreferencesProvider>
      <ToastProvider>
        {pathname.startsWith('/reader/') ? <ReaderRoutes /> : <AppShell><WorkspaceRoutes /></AppShell>}
      </ToastProvider>
    </PreferencesProvider>
  );
}
