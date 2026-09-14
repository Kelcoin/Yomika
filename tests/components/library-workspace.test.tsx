import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** jsdom has no layout: scrollTop, clientHeight and scrollHeight are all 0, so
 * every list reads as being at both ends at once. Pin what the gesture asks for. */
function scrollable(element: HTMLElement, metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { value, configurable: true, writable: true });
  }
}

describe('library workspace', () => {
  it('keeps a useful empty state', () => {
    renderWorkspace({ archives: [] });
    expect(screen.getByRole('heading', { name: '暂无档案库' })).toBeInTheDocument();
  });

  it('renders a virtualized archive list and selectable detail pane', async () => {
    const user = userEvent.setup();
    renderWorkspace({ archives });

    // The status bar reads the total from the server itself; the page no longer publishes one.
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

  it('cycles between the two cover-bearing display modes only', async () => {
    const user = userEvent.setup();
    renderWorkspace({ archives });

    // The no-cover "compact" mode is gone: wide ⇄ thumbnail.
    const cycle = screen.getByRole('button', { name: /显示模式：缩略图列表/ });
    await user.click(cycle);
    expect(screen.getByRole('button', { name: /显示模式：缩略图卡片/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /显示模式：缩略图卡片/ }));
    expect(screen.getByRole('button', { name: /显示模式：缩略图列表/ })).toBeInTheDocument();
  });

  it('marks a row as selected only once one has been chosen', async () => {
    const user = userEvent.setup();
    renderWorkspace({ archives });

    // The first row used to render pressed on every visit, because the selection
    // was seeded with `archives[0]` — so the list always looked like something
    // had been clicked, including on the shelves, which show no detail pane.
    const rows = screen.getAllByRole('button', { name: /^Archive \d/ });
    expect(rows.every((row) => row.getAttribute('aria-pressed') === 'false')).toBe(true);

    await user.click(rows[1]!);
    expect(screen.getByRole('button', { name: /^Archive 1\b/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Archive 0\b/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders search input and sort controls', () => {
    renderWorkspace({ archives });

    expect(screen.getByLabelText('搜索档案')).toBeInTheDocument();
    // The field carries the direction now; the button that used to hold it is
    // gone, which is also where the multi-select toggle sits.
    expect(screen.getByRole('button', { name: '名称' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /按.*序$/ })).toBeNull();
  });

  it('applies and saves search presets from the toolbar', async () => {
    const user = userEvent.setup();
    const preset = {
      scopeId: 'scope-a', presetId: 'p1', name: '中文汉化', query: 'language:chinese$',
      sortBy: 'title' as const, sortOrder: 'asc' as const, categoryId: null,
      createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z',
      deviceId: 'device-a', revision: 1, deleted: false,
    };
    const onApplyPreset = vi.fn();
    const onSavePreset = vi.fn();
    const onDeletePreset = vi.fn();
    renderWorkspace({ archives, presets: [preset], onApplyPreset, onSavePreset, onDeletePreset });

    // Everything a preset can do lives in one menu behind the bookmark button.
    await user.click(screen.getByRole('button', { name: '检索预设' }));
    await user.click(await screen.findByRole('menuitem', { name: '中文汉化' }));
    expect(onApplyPreset).toHaveBeenCalledWith(preset);

    await user.click(screen.getByRole('button', { name: '检索预设' }));
    await user.click(await screen.findByRole('menuitem', { name: '新增预设' }));
    expect(onSavePreset).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '检索预设' }));
    await user.click(await screen.findByRole('button', { name: '删除预设 中文汉化' }));
    expect(onDeletePreset).toHaveBeenCalledWith(preset);
  });

  it('virtualizes the thumbnail grid instead of mounting every archive', async () => {
    const user = userEvent.setup();
    renderWorkspace({ archives });

    // wide (default) → thumbnail; the no-cover compact mode is gone
    await user.click(screen.getByRole('button', { name: /显示模式：缩略图列表/ }));

    const items = screen.getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(archives.length / 2);
    // The last archive of the page must stay unmounted until it scrolls in.
    expect(screen.queryByRole('button', { name: /^Archive 99\b/ })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.archive-thumb-grid-row').length).toBeGreaterThan(0);
  });

  it('surfaces archive classification and reading metadata as compact chips', () => {
    // The category comes from the `category:` tag, not from the local
    // `archives.category` column — nothing has ever written that column, so
    // reading it first only made the source order look richer than it was. The
    // label is translated through the same map the detail pane's tag list uses.
    renderWorkspace({ archives: [{ ...archives[0]!, tags: ['category:Manga'], language: '中文' }] });

    expect(screen.getAllByText('漫画').some((element) => element.classList.contains('metadata-chip'))).toBe(true);
    expect(screen.getAllByText('中文').some((element) => element.classList.contains('metadata-chip'))).toBe(true);
    expect(screen.getAllByText('1 页').some((element) => element.classList.contains('metadata-chip'))).toBe(true);
  });

  it('uses card-shaped skeletons while the initial archive page is loading', () => {
    renderWorkspace({ archives: [], listLoading: true, cardStyle: 'wide' });
    expect(screen.getByRole('status', { name: '正在读取档案' })).toHaveClass('archive-list-skeleton');
    expect(document.querySelectorAll('.archive-row-skeleton')).toHaveLength(5);
    expect(screen.queryByText('暂无档案库')).not.toBeInTheDocument();
  });

  it('distributes wide-card tags across three left-starting rows', () => {
    const tags = ['female:ta', 'female:tb', 'female:tc', 'female:td', 'female:te', 'female:tf'];
    renderWorkspace({ archives: [{ ...archives[0]!, tags }] });
    const rows = [...document.querySelectorAll('.archive-row-tag-line')];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [...row.querySelectorAll('.metadata-chip')].map((chip) => chip.textContent)))
      .toEqual([['ta', 'td'], ['tb', 'te'], ['tc', 'tf']]);
  });

  it('renders history time on the connected rail outside the archive button', () => {
    renderWorkspace({
      archives: archives.slice(0, 2),
      timelineByArchiveId: new Map([
        ['archive-0', { date: '2026-09-11', dayLabel: '今天', time: '08:15' }],
        ['archive-1', { date: '2026-09-11', dayLabel: '今天', time: '09:30' }],
      ]),
    });

    const firstItem = screen.getAllByRole('listitem')[0]!;
    const card = screen.getByRole('button', { name: /^Archive 0\b/ });
    const timeline = firstItem.querySelector<HTMLElement>('.archive-row-timeline');
    // The day's first row names the day; every row still shows its own time.
    expect(timeline).toHaveTextContent('今天');
    expect(timeline).toHaveTextContent('08:15');
    expect(card).not.toContainElement(timeline);

    const secondItem = screen.getAllByRole('listitem')[1]!;
    const secondTimeline = secondItem.querySelector<HTMLElement>('.archive-row-timeline');
    expect(secondTimeline?.querySelector('.archive-row-timeline-day')).toBeNull();
    expect(secondTimeline).toHaveTextContent('09:30');
  });

  it('refreshes only when a pull past the top of the list is released', async () => {
    const onRefresh = vi.fn();
    renderWorkspace({ archives, onRefresh });
    const list = screen.getByRole('list', { name: '档案' });
    const pull = list.querySelector('.archive-list-pull') as HTMLElement;
    // jsdom has no layout and reports zeros, which read as "at both ends".
    scrollable(list, { scrollTop: 0, clientHeight: 800, scrollHeight: 4000 });

    // The list itself moves with the gesture, damped to half the wheel travel,
    // and the disc comes with it.
    fireEvent.wheel(list, { deltaY: -40 });
    expect(pull).toHaveStyle({ transform: 'translateY(20px)' });
    expect(list.querySelector('.library-pull-indicator')).toHaveClass('is-visible');
    // Short of the threshold, so letting go springs the list back.
    await act(() => new Promise((resolve) => setTimeout(resolve, 260)));
    expect(onRefresh).not.toHaveBeenCalled();
    expect(pull).toHaveStyle({ transform: 'translateY(0px)' });
    expect(list.querySelector('.library-pull-indicator')).not.toHaveClass('is-visible');

    // Scrolling the other way is ordinary scrolling, never an overscroll.
    fireEvent.wheel(list, { deltaY: 120 });
    expect(pull).toHaveStyle({ transform: 'translateY(0px)' });

    // Past the threshold, releasing hands it to the refresh; the list goes back
    // to its place while the disc stays over it.
    fireEvent.wheel(list, { deltaY: -200 });
    expect(pull).toHaveStyle({ transform: 'translateY(100px)' });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(pull).toHaveStyle({ transform: 'translateY(0px)' });
  });

  it('keeps the refresh disc styled and hidden until it has something to say', () => {
    // A class built as `disc${cond ? ' x' : undefined}` renders as
    // "discundefined": no rule matches, so the bare icon sat drawn in the corner
    // of the list for good. Assert the class list itself, not just the element.
    const { rerender } = renderWorkspace({ archives, onRefresh: () => {} });
    const list = screen.getByRole('list', { name: '档案' });
    const indicator = list.querySelector('.library-pull-indicator');
    const disc = list.querySelector('.library-pull-disc');

    expect(indicator).not.toBeNull();
    expect(disc).not.toBeNull();
    expect(disc?.className).toBe('library-pull-disc');
    expect(indicator?.className).toBe('library-pull-indicator');
    // Nothing inside the list may carry a class that came from an undefined.
    expect(list.innerHTML).not.toMatch(/class="[^"]*undefined/);

    rerender(<MemoryRouter><LibraryWorkspace archives={archives} onRefresh={() => {}} refreshing /></MemoryRouter>);
    expect(list.querySelector('.library-pull-disc')?.className).toBe('library-pull-disc is-spinning');
    expect(list.querySelector('.library-pull-indicator')?.className).toBe('library-pull-indicator is-visible');
  });

  it('bounces off the bottom of the list without asking for anything', async () => {
    const onRefresh = vi.fn();
    renderWorkspace({ archives, onRefresh });
    const list = screen.getByRole('list', { name: '档案' });
    const pull = list.querySelector('.archive-list-pull') as HTMLElement;
    scrollable(list, { scrollTop: 3200, clientHeight: 800, scrollHeight: 4000 });

    // The last wheel notch past the end lifts the list instead of scrolling it.
    fireEvent.wheel(list, { deltaY: 100 });
    expect(pull).toHaveStyle({ transform: 'translateY(-50px)' });
    // The end of the list is not a refresh, and the disc never shows for it.
    expect(list.querySelector('.library-pull-indicator')).not.toHaveClass('is-visible');
    await act(() => new Promise((resolve) => setTimeout(resolve, 260)));
    expect(pull).toHaveStyle({ transform: 'translateY(0px)' });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('bounces on the shelves too, where there is no refresh to ask for', () => {
    // No onRefresh: the shelves get the same overscroll, minus the disc.
    renderWorkspace({ archives: archives.slice(0, 5) });
    const list = screen.getByRole('list', { name: '档案' });
    const pull = list.querySelector('.archive-list-pull') as HTMLElement;
    scrollable(list, { scrollTop: 0, clientHeight: 800, scrollHeight: 4000 });

    fireEvent.wheel(list, { deltaY: -200 });
    expect(pull).toHaveStyle({ transform: 'translateY(100px)' });
    expect(list.querySelector('.library-pull-indicator')).toBeNull();
  });

  it('forwards wheel gestures from the panel gutters to the list', () => {
    // 桌面端书架页面不滚动，唯一滚动容器是 .archive-list：鼠标悬在面板的
    // 左右留白上时，滚轮目标链不经过它，什么都不动。转发给同面板的列表。
    const { container } = render(
      <MemoryRouter>
        <div className="library-shell-list"><LibraryWorkspace archives={archives.slice(0, 20)} /></div>
      </MemoryRouter>,
    );
    const list = container.querySelector('[data-scroll-region]') as HTMLElement;
    scrollable(list, { scrollTop: 0, clientHeight: 600, scrollHeight: 4000 });
    const host = list.closest('.library-shell-list') as HTMLElement;

    // 留白上的滚轮：转发给列表。
    fireEvent.wheel(host, { deltaY: 120 });
    expect(list.scrollTop).toBe(120);
    fireEvent.wheel(host, { deltaY: -40 });
    expect(list.scrollTop).toBe(80);

    // 鼠标在列表内：浏览器原生滚动负责，转发不得叠加。
    fireEvent.wheel(list, { deltaY: 100 });
    expect(list.scrollTop).toBe(80);
  });

  it('pulls with a finger and refreshes on lift', () => {
    const onRefresh = vi.fn();
    renderWorkspace({ archives, onRefresh });
    const list = screen.getByRole('list', { name: '档案' });
    const pull = list.querySelector('.archive-list-pull') as HTMLElement;
    scrollable(list, { scrollTop: 0, clientHeight: 800, scrollHeight: 4000 });

    fireEvent.touchStart(list, { touches: [{ clientY: 10 }] });
    // Dragging up is the list scrolling itself, so it must not pull.
    fireEvent.touchMove(list, { touches: [{ clientY: 0 }] });
    expect(pull).toHaveStyle({ transform: 'translateY(0px)' });

    fireEvent.touchStart(list, { touches: [{ clientY: 10 }] });
    fireEvent.touchMove(list, { touches: [{ clientY: 170 }] });
    expect(pull).toHaveStyle({ transform: 'translateY(80px)' });
    // A held pull has not been released yet, so nothing has been asked for.
    expect(onRefresh).not.toHaveBeenCalled();

    fireEvent.touchEnd(list);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // The list is already back where it belongs; the disc carries the request.
    expect(pull).toHaveStyle({ transform: 'translateY(0px)' });
  });

  it('sorts by choosing a field, and flips the direction when it is chosen again', async () => {
    const user = userEvent.setup();
    const onSortModeChange = vi.fn();
    const onSortOrderChange = vi.fn();
    renderWorkspace({
      archives: archives.slice(0, 5),
      sortMode: 'added',
      sortOrder: 'desc',
      onSortModeChange,
      onSortOrderChange,
    });

    // Another field: the mode changes and the direction is left alone.
    await user.click(screen.getByRole('button', { name: '添加时间' }));
    await user.click(within(screen.getByRole('listbox')).getByRole('button', { name: '名称' }));
    expect(onSortModeChange).toHaveBeenCalledWith('title');
    expect(onSortOrderChange).not.toHaveBeenCalled();

    // The field already chosen: the same click flips the direction instead.
    await user.click(screen.getByRole('button', { name: '添加时间' }));
    await user.click(within(screen.getByRole('listbox')).getByRole('button', { name: '添加时间' }));
    expect(onSortOrderChange).toHaveBeenCalledWith('asc');
    expect(onSortModeChange).toHaveBeenCalledTimes(1);
  });

  it('selects cards with a click, a shift range, and a ctrl click outside the mode', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    const onSelectionModeChange = vi.fn();
    renderWorkspace({
      archives: archives.slice(0, 4),
      selectionMode: true,
      selectedArchiveIds: new Set<string>(),
      onSelectionChange,
      onSelectionModeChange,
    });
    const card = (index: number) => screen.getByRole('checkbox', { name: `选择 Archive ${index}` });

    await user.click(card(0));
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['archive-0']));

    // Shift reaches back to the card last touched and takes everything between.
    await user.keyboard('{Shift>}');
    await user.click(card(2));
    await user.keyboard('{/Shift}');
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['archive-0', 'archive-1', 'archive-2']));
  });

  it('enters the selection mode from a ctrl click on a card', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    const onSelectionModeChange = vi.fn();
    renderWorkspace({ archives: archives.slice(0, 4), onSelectionChange, onSelectionModeChange });

    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('button', { name: /^Archive 1\b/ }));
    await user.keyboard('{/Control}');

    expect(onSelectionModeChange).toHaveBeenCalledWith(true);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['archive-1']));
  });

  it('shows the selection bar with a count, select-all, and the page actions', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderWorkspace({
      archives: archives.slice(0, 4),
      selectionMode: true,
      selectedArchiveIds: new Set(['archive-0']),
      onSelectionChange,
      selectionActions: <button type="button">删除所选</button>,
    });

    expect(screen.getByText('已选 1 个')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除所选' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '全选当前' }));
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['archive-0', 'archive-1', 'archive-2', 'archive-3']));
  });

  it('offers select-all-finished in the selection bar when the page can define it', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    const onSelectAllFinished = vi.fn(() => onSelectionChange(new Set(['archive-1', 'archive-3'])));
    renderWorkspace({
      archives: archives.slice(0, 4),
      selectionMode: true,
      onSelectionChange,
      onSelectAllFinished,
      finishedSelectableCount: 2,
    });

    const button = screen.getByRole('button', { name: '全选已读完' });
    await user.click(button);
    expect(onSelectAllFinished).toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['archive-1', 'archive-3']));

    // 没有已读完条目时按钮被禁用而不是消失——多选里少一个动作比动作闪现清楚。
    cleanup();
    renderWorkspace({
      archives: archives.slice(0, 2),
      selectionMode: true,
      onSelectionChange,
      onSelectAllFinished,
      finishedSelectableCount: 0,
    });
    expect(screen.getByRole('button', { name: '全选已读完' })).toBeDisabled();
  });

  it('offers the multi-select toggle beside the presets where there is no toolbar', () => {
    const onSelectionModeChange = vi.fn();
    renderWorkspace({ archives: archives.slice(0, 4), showToolbar: false, onSavePreset: () => {}, onSelectionModeChange });

    // No toolbar on the shelves: the toggle joins the search row instead.
    expect(screen.queryByRole('toolbar', { name: '档案库工具' })).toBeNull();
    expect(screen.getByRole('button', { name: '多选' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '检索预设' })).toBeInTheDocument();
  });

  it('does not render the obsolete category assignment control', () => {
    renderWorkspace({ archives: archives.slice(0, 1), categories: [{ id: 'favorite', name: '收藏', pinned: false, search: null, archives: [] }] });
    expect(screen.queryByRole('button', { name: '加入分类' })).not.toBeInTheDocument();
  });

  it('opens the selected archive in the reader from the primary detail action', () => {
    renderWorkspace({ archives: archives.slice(0, 1) });

    expect(screen.getByRole('link', { name: '阅读 Archive 0' })).toHaveAttribute('href', '/reader/archive-0?server=local');
  });
});
