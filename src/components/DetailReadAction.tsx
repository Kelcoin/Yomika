import { BookOpen } from 'lucide-react';
import { Link, type LinkProps } from 'react-router-dom';

export function DetailActionSkeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`secondary-action archive-action-skeleton ${className}`} />;
}

export function DetailReadAction({ ready, pageIndex, longPressHint, ...link }: LinkProps & {
  ready: boolean;
  pageIndex: number | null;
  longPressHint?: boolean;
}) {
  if (!ready) return <DetailActionSkeleton className="archive-read-label-skeleton" />;
  const resume = pageIndex !== null;
  const label = resume ? `从第 ${pageIndex + 1} 页继续` : '阅读';
  return <Link {...link} className="secondary-action archive-read-action" aria-label={label} aria-disabled={false} title={longPressHint ? `${label}（长按进入无痕阅读）` : label}>
    <BookOpen aria-hidden="true" />
    <span className={`archive-action-label${resume ? ' archive-resume-label' : ''}`}>{label}</span>
    {resume && <span className="archive-action-label-short" aria-hidden="true">继续</span>}
  </Link>;
}
