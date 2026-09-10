import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export function useReturnNavigation(fallback = '/library') {
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(() => {
    const returnTo = (location.state as { returnTo?: unknown } | null)?.returnTo;
    if (typeof returnTo === 'string' && returnTo.startsWith('/')) {
      navigate(returnTo, { replace: true });
      return;
    }
    // Router keys track in-app navigation, unlike window.history.length which
    // may count pages outside this application and disagrees with MemoryRouter.
    const index = window.history.state?.idx;
    if (typeof index === 'number' ? index > 0 : location.key !== 'default') navigate(-1);
    else navigate(fallback, { replace: true });
  }, [fallback, location.key, location.state, navigate]);
}
