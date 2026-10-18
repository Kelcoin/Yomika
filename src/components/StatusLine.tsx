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
export function StatusLine({ children, tone = 'muted', busy = false, region = false, as: Element = 'p' }: {
  children: ReactNode;
  tone?: 'muted' | 'error';
  /** The line reports work in flight rather than an empty result: draw the
   * shared mark beside the text instead of leaving the wait unstated. */
  busy?: boolean;
  /** 这一行顶替的是**整块内容区**，不是列表里的一行：取 `.empty-state` 的几何
   * （居中、同一段最小高度、同一处留白），标记也放大到 `is-sm` 那一档。空状态是
   * `EmptyState`、加载态却是左上角一行小字的那些页面就该用它——两态长得不一样时，
   * 用户看到的是「页面坏了」而不是「还在读」。列表里、卡片里、表单里的行不要用它。 */
  region?: boolean;
  /** `li` for a line that stands in for the rows of a list, so it stays a valid
   * child of the `<ul>` it belongs to. Same line either way. */
  as?: 'p' | 'li';
}) {
  return (
    <Element className={`status-line is-${tone}${region ? ' is-region' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
      {busy && <LoadingIndicator inline />}
      {children}
    </Element>
  );
}
