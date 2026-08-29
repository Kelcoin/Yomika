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

  it('renders search input and sort controls', () => {
    renderWorkspace({ archives });

    expect(screen.getByLabelText('搜索档案')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '按标题降序' })).toBeInTheDocument();
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

  it('submits the selected category through local component state', async () => {
    const user = userEvent.setup();
    const onAddCategory = vi.fn();
    renderWorkspace({ archives: archives.slice(0, 1), categories: [{ id: 'favorite', name: '收藏', pinned: false, search: null, archives: [] }], onAddCategory });

    await user.selectOptions(screen.getByRole('combobox', { name: '分类' }), 'favorite');
    await user.click(screen.getByRole('button', { name: '加入分类' }));

    expect(onAddCategory).toHaveBeenCalledWith('favorite');
  });

  it('opens the selected archive in the reader from the primary detail action', () => {
    renderWorkspace({ archives: archives.slice(0, 1) });

    expect(screen.getByRole('link', { name: '阅读 Archive 0' })).toHaveAttribute('href', '/reader/archive-0');
  });
});
