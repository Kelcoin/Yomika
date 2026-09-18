import type { ReactNode } from 'react';

import { LoadingIndicator } from './LoadingIndicator';

/** One line of status inside a list, panel or region: "nothing here yet",
 * "still loading", "that failed".
 *
 * The inline counterpart to EmptyState — the whole-region version with an icon
 * and a title. Both were written out wherever they were needed, which is how
 * four of them ended up reusing EmptyState's own class on a `<p>` and inheriting
 * its 320px centring for a single sentence.
 *
 *   muted  nothing to show yet, or a list that is still filling in
 *   error  the ask itself failed
 *
 * Quieter than the content it replaces: `--text-sm` against the row hints, so an
 * empty list does not read louder than the rows that will arrive.
 */
export function StatusLine({ children, tone = 'muted', busy = false, as: Element = 'p' }: {
  children: ReactNode;
  tone?: 'muted' | 'error';
  /** The line reports work in flight rather than an empty result: draw the
   * shared mark beside the text instead of leaving the wait unstated. */
  busy?: boolean;
  /** `li` for a line that stands in for the rows of a list, so it stays a valid
   * child of the `<ul>` it belongs to. Same line either way. */
  as?: 'p' | 'li';
}) {
  return (
    <Element className={`status-line is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {busy && <LoadingIndicator inline />}
      {children}
    </Element>
  );
}
