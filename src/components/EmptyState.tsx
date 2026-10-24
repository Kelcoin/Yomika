import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Content panels use less whitespace than full-page empty states. */
  compact?: boolean;
  /** Optional call to action. It used to be a sibling pulled back up with a
   * negative margin, which only lined up on the one page that did it. */
  action?: ReactNode;
}

/** One shape for "there is nothing here", on every page.
 *
 * It used to be a left-aligned icon-and-text row that sat under whatever heading
 * the page happened to have, and three other places said the same thing as a
 * bare paragraph instead. Centred in the space it is given, so an empty shelf
 * reads as an empty shelf rather than as a page that failed to finish drawing. */
export function EmptyState({ icon: Icon, title, description, action, compact = false }: EmptyStateProps) {
  return (
    <section className={`empty-state${compact ? ' is-compact' : ''}`}>
      <Icon aria-hidden="true" />
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action}
    </section>
  );
}
