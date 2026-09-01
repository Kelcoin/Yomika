import type { ReactNode } from 'react';

export function DeduplicationCard({ title, meta, children, actions }: { title: string; meta?: string; children: ReactNode; actions?: ReactNode }) {
  return <article className="dedup-group"><div className="dedup-group-heading"><strong>{title}</strong>{meta && <span>{meta}</span>}</div>{children}{actions}</article>;
}
