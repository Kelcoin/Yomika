/** The one loading indicator the app uses.
 *
 * Routes used to invent their own: a bare "正在加载…" line here, an empty state
 * claiming 没有档案 there — the second is a lie while a request is still in
 * flight, and the pair is indistinguishable from "this archive really is empty".
 * A single component keeps the two states apart by construction.
 *
 * The mark is drawn rather than imported: a spinner made of the project's own
 * three page shapes, which is also what the favicon and the About page use.
 */
export function LoadingIndicator({ label = '正在加载', size = 'md' }: { label?: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div className={`loading-indicator is-${size}`} role="status" aria-label={label}>
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        {/* Three leaves of a turning page, each a third of the cycle behind the
            last, so the motion reads as paging rather than spinning. */}
        <g fill="none" strokeLinecap="round" strokeWidth="3">
          <path className="loading-leaf" d="M24 6 L38 13 L38 35 L24 42 Z" />
          <path className="loading-leaf" d="M24 6 L10 13 L10 35 L24 42 Z" />
          <path className="loading-spine" d="M24 6 L24 42" />
        </g>
      </svg>
      <span className="loading-indicator-label">{label}</span>
    </div>
  );
}
