import { useEffect, useState } from 'react';
import { COMPACT_WIDTH_QUERY, DEVICE_LAYOUT_EVENT, isMobileDevice } from './layoutMode';

/** Desktop width at which the app switches to its compact layout: the sidebar is
 * replaced by the bottom nav, panes stack, and settings become a list that
 * drills into one section at a time.
 *
 * Native mobile devices stay compact at every width. CSS reads the same
 * data-layout attribute maintained by layoutMode. The desktop breakpoint sits
 * at 900px rather than a phone width because the
 * desktop shell needs 248px of sidebar plus two library panes; below this the
 * content was squeezed narrower than the compact layout would have made it.
 */
export { COMPACT_WIDTH_QUERY } from './layoutMode';

/** Subscribes to a media query. Returns false where `matchMedia` is missing, so
 * a non-browser environment renders the wide layout rather than crashing. */
export function useMediaQuery(query: string): boolean {
  const read = () => (query === COMPACT_WIDTH_QUERY && isMobileDevice()) || (window.matchMedia?.(query).matches ?? false);
  const [matches, setMatches] = useState(read);

  useEffect(() => {
    const list = window.matchMedia?.(query);
    const update = () => setMatches((query === COMPACT_WIDTH_QUERY && isMobileDevice()) || (list?.matches ?? false));
    update();
    list?.addEventListener('change', update);
    if (query === COMPACT_WIDTH_QUERY) window.addEventListener(DEVICE_LAYOUT_EVENT, update);
    return () => {
      list?.removeEventListener('change', update);
      window.removeEventListener(DEVICE_LAYOUT_EVENT, update);
    };
  }, [query]);

  return matches;
}
