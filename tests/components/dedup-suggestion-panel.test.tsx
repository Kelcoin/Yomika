import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DedupSuggestionPanel } from '../../src/components/DedupSuggestionPanel';
import type { DHashMatch } from '../../src/domain/dedup';

describe('DedupSuggestionPanel', () => {
  const sampleMatches: DHashMatch[] = [
    { id: 'archive-a', hash: 'a'.repeat(16), distance: 2 },
    { id: 'archive-b', hash: 'b'.repeat(16), distance: 5 },
    { id: 'archive-c', hash: 'c'.repeat(16), distance: 10 },
  ];

  it('renders a list of dHash matches sorted by distance', () => {
    render(<DedupSuggestionPanel matches={sampleMatches} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText('archive-a')).toBeDefined();
    expect(within(items[0]!).getByText('距离: 2')).toBeDefined();
    expect(within(items[1]!).getByText('archive-b')).toBeDefined();
    expect(within(items[2]!).getByText('archive-c')).toBeDefined();
  });

  it('shows empty state when no matches provided', () => {
    render(<DedupSuggestionPanel matches={[]} />);
    expect(screen.getByText('未发现相似档案')).toBeDefined();
  });

  it('calls onDismiss with the match id when dismiss button clicked', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<DedupSuggestionPanel matches={sampleMatches} onDismiss={onDismiss} />);
    const dismissButtons = screen.getAllByRole('button', { name: /忽略/ });
    await user.click(dismissButtons[0]!);
    expect(onDismiss).toHaveBeenCalledWith('archive-a');
  });

  it('excludes dismissed ids from the displayed list', () => {
    render(<DedupSuggestionPanel matches={sampleMatches} dismissedIds={new Set(['archive-a'])} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(screen.queryByText('archive-a')).toBeNull();
  });

  it('shows summary count of remaining suggestions', () => {
    render(<DedupSuggestionPanel matches={sampleMatches} dismissedIds={new Set(['archive-a', 'archive-b'])} />);
    expect(screen.getByText(/1 个相似建议/)).toBeDefined();
  });

  it('shows loading state when checking is true', () => {
    render(<DedupSuggestionPanel matches={[]} checking />);
    expect(screen.getByText('正在检查重复...')).toBeDefined();
  });

  it('renders distance color indicator for close matches', () => {
    render(<DedupSuggestionPanel matches={[sampleMatches[0]!]} />);
    const indicator = screen.getByTestId('distance-indicator');
    expect(indicator.className).toContain('close');
  });
});
