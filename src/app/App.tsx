import { AppShell } from '../components/AppShell';
import { useLocation } from 'react-router-dom';
import { ReaderRoutes, WorkspaceRoutes } from './routes';
import { PreferencesProvider } from './preferences';

export function App() {
  const { pathname } = useLocation();
  return (
    <PreferencesProvider>
      {pathname.startsWith('/reader/') ? <ReaderRoutes /> : (
        <AppShell>
          <WorkspaceRoutes />
        </AppShell>
      )}
    </PreferencesProvider>
  );
}
