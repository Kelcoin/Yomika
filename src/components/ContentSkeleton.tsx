/** Placeholder rows keep settings and auxiliary panels close to their final geometry. */
export function ContentSkeleton({ label, rows = 3, variant = 'settings' }: {
  label: string;
  rows?: number;
  variant?: 'settings' | 'comments' | 'log';
}) {
  return <div className={`content-skeleton is-${variant}`} role="status" aria-label={label}>
    {Array.from({ length: rows }, (_, index) => <div className="content-skeleton-row" key={index} aria-hidden="true">
      {variant === 'settings' && <span className="skeleton-block content-skeleton-icon" />}
      <div className="content-skeleton-copy"><span className="skeleton-line" /><span className="skeleton-line" /></div>
      {variant === 'settings' && <span className="skeleton-block content-skeleton-control" />}
    </div>)}
  </div>;
}
