import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isMobileDevice } from './layoutMode';
import { MOBILE_BACK_EVENT } from './pageBackNavigation';

export function useReturnNavigation(fallback = '/library') {
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(() => {
    if (isMobileDevice() && !window.dispatchEvent(new Event(MOBILE_BACK_EVENT, { cancelable: true }))) return;
    // In-app editors are pushed from their origin. Pop that entry instead of
    // replacing it with a duplicate of the origin (which makes Back stay put).
    if ((location.state as { returnViaHistory?: boolean } | null)?.returnViaHistory && location.key !== 'default') {
      navigate(-1);
      return;
    }
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
