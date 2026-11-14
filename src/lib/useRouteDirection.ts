import { useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import type { RouteDirection } from '../app/RetainedPage';

/** Router keys distinguish forward history traversal from Back, including
 * multiple entries with the same URL. No dependence on browser-only history.idx. */
export function useRouteDirection(): RouteDirection {
  const location = useLocation();
  const navigation = useNavigationType();
  const state = useRef({ key: location.key, index: 0, entries: [location.key], direction: 1 as RouteDirection });
  const current = state.current;
  if (current.key !== location.key) {
    const known = current.entries.indexOf(location.key);
    if (navigation === 'POP') {
      current.direction = known >= 0 && known > current.index ? 1 : -1;
      if (known >= 0) current.index = known;
      else { current.entries.unshift(location.key); current.index = 0; }
    } else if (navigation === 'REPLACE') {
      current.entries[current.index] = location.key;
      // Mobile Back deliberately replaces a page-local route rather than
      // traversing the browser's cross-tab history. Keep its return direction.
      current.direction = (location.state as { routeDirection?: unknown } | null)?.routeDirection === -1 ? -1 : 1;
    } else {
      current.entries.splice(current.index + 1, Infinity, location.key);
      current.index++;
      current.direction = 1;
    }
    current.key = location.key;
  }
  return current.direction;
}
