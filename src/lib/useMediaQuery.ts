import { useEffect, useState } from 'react';

/** The width at which the app switches to its compact layout: the sidebar is
 * replaced by the bottom nav, panes stack, and settings become a list that
 * drills into one section at a time.
 *
 * Keep in step with the `@media (max-width: …)` blocks in `styles/shell.css` and
 * `styles/reader.css`. It sits at 900px rather than a phone width because the
 * desktop shell needs 248px of sidebar plus two library panes; below this the
 * content was squeezed narrower than the compact layout would have made it.
 */
export const COMPACT_WIDTH_QUERY = '(max-width: 900px)';

/** Subscribes to a media query. Returns false where `matchMedia` is missing, so
 * a non-browser environment renders the wide layout rather than crashing. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    setMatches(list.matches);
    const update = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}
