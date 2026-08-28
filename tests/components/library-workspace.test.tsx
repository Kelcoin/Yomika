import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { LibraryWorkspace } from '../../src/components/LibraryWorkspace';
import type { ArchiveRecord } from '../../src/domain/library';

const archives: ArchiveRecord[] = Array.from({ length: 100 }, (_, index) => ({
  serverId: 'local',
  archiveId: `archive-${index}`,
  title: `Archive ${index}`,
  pageCount: index + 1,
  updatedAt: '2026-08-26T00:00:00.000Z',
}));

describe('library workspace', () => {
  it('keeps a useful empty state', () => {
    render(<LibraryWorkspace archives={[]} />);
    expect(screen.getByRole('heading', { name: '暂无档案库' })).toBeInTheDocument();
  });

  it('renders a virtualized archive list and selectable detail pane', async () => {
    const user = userEvent.setup();
    render(<LibraryWorkspace archives={archives} />);

    expect(screen.getByText('100 项')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Archive 1\b/ }));
    expect(screen.getByRole('heading', { name: 'Archive 1' })).toBeInTheDocument();
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('renders search input and sort controls', () => {
    render(<LibraryWorkspace archives={archives} />);

    expect(screen.getByLabelText('搜索档案')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '按标题降序' })).toBeInTheDocument();
  });

  it('sorts archives by title ascending and descending', async () => {
    const user = userEvent.setup();
    render(<LibraryWorkspace archives={archives.slice(0, 5)} />);

    expect(screen.getByRole('button', { name: /^Archive 0\b/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '按标题降序' }));
    expect(screen.getByText('5 项')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '按标题升序' }));
    expect(screen.getByText('5 项')).toBeInTheDocument();
  });

  it('submits the selected category through local component state', async () => {
    const user = userEvent.setup();
    const onAddCategory = vi.fn();
    render(<LibraryWorkspace archives={archives.slice(0, 1)} categories={[{ id: 'favorite', name: '收藏', pinned: false, search: null, archives: [] }]} onAddCategory={onAddCategory} />);

    await user.selectOptions(screen.getByRole('combobox', { name: '分类' }), 'favorite');
    await user.click(screen.getByRole('button', { name: '加入分类' }));

    expect(onAddCategory).toHaveBeenCalledWith('favorite');
  });
});
