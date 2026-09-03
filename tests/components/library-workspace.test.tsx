import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { LibraryWorkspace } from '../../src/components/LibraryWorkspace';
import type { ArchiveRecord } from '../../src/domain/library';

const archives: ArchiveRecord[] = Array.from({ length: 100 }, (_, index) => ({
  serverId: 'local',
  archiveId: `archive-${index}`,
  title: `Archive ${index}`,
  pageCount: index + 1,
  updatedAt: '2026-08-26T00:00:00.000Z',
}));

function renderWorkspace(props: React.ComponentProps<typeof LibraryWorkspace>) {
  return render(<MemoryRouter><LibraryWorkspace {...props} /></MemoryRouter>);
}

describe('library workspace', () => {
  it('keeps a useful empty state', () => {
    renderWorkspace({ archives: [] });
    expect(screen.getByRole('heading', { name: '暂无档案库' })).toBeInTheDocument();
  });

  it('renders a virtualized archive list and selectable detail pane', async () => {
    const user = userEvent.setup();
    renderWorkspace({ archives });

    expect(screen.getByText('100 项')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Archive 1\b/ }));
    expect(screen.getByRole('heading', { name: 'Archive 1' })).toBeInTheDocument();
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('submits the search on Enter or a finished tag, not on every keystroke', async () => {
    const user = userEvent.setup();
    const onSearchQueryChange = vi.fn();
    renderWorkspace({ archives, searchQuery: '', onSearchQueryChange });
    const input = screen.getByLabelText('搜索档案');
    // Focus directly: in jsdom a pointer click inside the panel group lands on
    // the resizable separator (tabIndex=0) instead of the input.
    input.focus();

    await user.keyboard('artist');
    expect(input).toHaveValue('artist');
    expect(onSearchQueryChange).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onSearchQueryChange).toHaveBeenCalledWith('artist');

    onSearchQueryChange.mockClear();
    await user.clear(input);
    expect(onSearchQueryChange).toHaveBeenCalledWith('');

    onSearchQueryChange.mockClear();
    await user.keyboard('female:glasses');
    expect(onSearchQueryChange).not.toHaveBeenCalled();
    await user.keyboard('$');
    expect(onSearchQueryChange).toHaveBeenCalledWith('female:glasses$');
  });

  it('renders search input and sort controls', () => {
    renderWorkspace({ archives });

    expect(screen.getByLabelText('搜索档案')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '按标题降序' })).toBeInTheDocument();
  });

  it('virtualizes the thumbnail grid instead of mounting every archive', async () => {
    const user = userEvent.setup();
    renderWorkspace({ archives });

    // wide (default) → thumbnail
    await user.click(screen.getByRole('button', { name: /显示模式：有图列表/ }));

    const items = screen.getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(archives.length / 2);
    // The last archive of the page must stay unmounted until it scrolls in.
    expect(screen.queryByRole('button', { name: /^Archive 99\b/ })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.archive-thumb-grid-row').length).toBeGreaterThan(0);
  });

  it('surfaces archive classification and reading metadata as compact chips', () => {
    renderWorkspace({ archives: [{ ...archives[0]!, category: 'Manga', language: '中文' }] });

    expect(screen.getAllByText('Manga').some((element) => element.classList.contains('metadata-chip'))).toBe(true);
    expect(screen.getAllByText('中文').some((element) => element.classList.contains('metadata-chip'))).toBe(true);
    expect(screen.getAllByText('1 页').some((element) => element.classList.contains('metadata-chip'))).toBe(true);
  });

  it('uses an icon on the archive refresh tool', () => {
    renderWorkspace({ archives, onRefresh: vi.fn() });

    expect(screen.getByRole('button', { name: '刷新档案库' }).querySelector('svg')).toBeTruthy();
  });

  it('sorts archives by title ascending and descending', async () => {
    const user = userEvent.setup();
    renderWorkspace({ archives: archives.slice(0, 5) });

    expect(screen.getByRole('button', { name: /^Archive 0\b/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '按标题降序' }));
    expect(screen.getByText('5 项')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '按标题升序' }));
    expect(screen.getByText('5 项')).toBeInTheDocument();
  });

  it('does not render the obsolete category assignment control', () => {
    renderWorkspace({ archives: archives.slice(0, 1), categories: [{ id: 'favorite', name: '收藏', pinned: false, search: null, archives: [] }] });
    expect(screen.queryByRole('button', { name: '加入分类' })).not.toBeInTheDocument();
  });

  it('opens the selected archive in the reader from the primary detail action', () => {
    renderWorkspace({ archives: archives.slice(0, 1) });

    expect(screen.getByRole('link', { name: '阅读 Archive 0' })).toHaveAttribute('href', '/reader/archive-0');
  });
});
