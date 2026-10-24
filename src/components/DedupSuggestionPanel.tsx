import { CheckCheck, X } from 'lucide-react';
import type { DHashMatch } from '../domain/dedup';

import { StatusLine } from './StatusLine';
import { EmptyState } from './EmptyState';

interface DedupSuggestionPanelProps {
  matches: DHashMatch[];
  dismissedIds?: Set<string>;
  onDismiss?: (id: string) => void;
  checking?: boolean;
}

function distanceClass(distance: number): string {
  if (distance <= 3) return 'close';
  if (distance <= 8) return 'moderate';
  return 'distant';
}

export function DedupSuggestionPanel({ matches, dismissedIds = new Set(), onDismiss, checking }: DedupSuggestionPanelProps) {
  if (checking) {
    return (
      <section className="dedup-panel" aria-label="查重建议">
        <StatusLine busy>正在检查重复…</StatusLine>
      </section>
    );
  }

  const visible = matches.filter((m) => !dismissedIds.has(m.id));

  if (visible.length === 0) {
    return (
      <section className="dedup-panel" aria-label="查重建议">
        <EmptyState compact icon={CheckCheck} title="未发现相似档案" />
      </section>
    );
  }

  return (
    <section className="dedup-panel" aria-label="查重建议">
      <p>{visible.length} 个相似建议</p>
      <ul>
        {visible.map((match) => (
          <li key={match.id}>
            <span data-testid="distance-indicator" className={`distance-indicator ${distanceClass(match.distance)}`} />
            <span>{match.id}</span>
            <span>距离: {match.distance}</span>
            {onDismiss && (
              <button type="button" className="icon-button" aria-label={`忽略${match.id}`} title="忽略" onClick={() => onDismiss(match.id)}>
                <X aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
