import { useEffect } from 'react';
import { usePageActive } from './RetainedPage';

const WORKSPACE_REFRESH = 'yomika:workspace-refresh';

export function requestWorkspaceRefresh(route: string): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_REFRESH, { detail: route }));
}

export function useWorkspaceRefresh(route: string, refresh: () => void): void {
  const active = usePageActive();
  useEffect(() => {
    if (!active) return;
    const handleRefresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail === route) refresh();
    };
    window.addEventListener(WORKSPACE_REFRESH, handleRefresh);
    return () => window.removeEventListener(WORKSPACE_REFRESH, handleRefresh);
  }, [active, route, refresh]);
}
