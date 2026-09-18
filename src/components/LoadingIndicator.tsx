/** The one loading indicator the app uses.
 *
 * Routes used to invent their own: a bare "正在加载…" line here, an empty state
 * claiming 没有档案 there — the second is a lie while a request is still in
 * flight, and the pair is indistinguishable from "this archive really is empty".
 * A single component keeps the two states apart by construction.
 *
 * The mark is Material 3's circular indicator: a faint full track plus one
 * active arc (4dp stroke, round caps) whose head grows while its tail follows,
 * on a container turning one full turn per dash cycle. It replaced a mark built
 * from three page shapes — the reader showed this one for its own pages while
 * every route still showed the old one, and two loading marks in one app read as
 * two different kinds of waiting.
 *
 * No caption. `label` is the accessible name only: the text under the animation
 * said what the animation already says, and repeated it in three sizes across
 * every route that loads anything.
 */
export function LoadingIndicator({ label = '正在加载', size = 'md', inline = false }: { label?: string; size?: 'sm' | 'md' | 'lg'; inline?: boolean }) {
  const mark = (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      {/* 2πr ≈ 125.7 for r=20; the dash cycle trims the arc the way the spec's
          indicator does, and both cycles share one 1.6s period. */}
      <circle className="loading-indicator-track" cx="24" cy="24" r="20" />
      <circle className="loading-indicator-arc" cx="24" cy="24" r="20" />
    </svg>
  );
  // `inline` draws the mark alone, for a line whose own text already carries the
  // status: a spinner with role="status" inside a role="status" paragraph
  // announces the same wait twice.
  if (inline) return <span className="loading-mark" aria-hidden="true">{mark}</span>;
  return (
    <div className={`loading-indicator is-${size}`} role="status" aria-label={label}>
      {mark}
    </div>
  );
}
