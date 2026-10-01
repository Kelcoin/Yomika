import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { LibraryWorkspace, RAIL_MAX_TICKS, WIDE_COVER_MARK_LIMIT, withWideCoverMark } from '../../src/components/LibraryWorkspace';
import { ArchiveThumbnailCard } from '../../src/components/ArchiveThumbnailCard';
import { rememberWideCoverMark, resetWideCoverMarksForTests, isWideCoverMarked } from '../../src/lib/archiveCardPresentation';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { COMPACT_WIDTH_QUERY } from '../../src/lib/useMediaQuery';
import type { ArchiveRecord } from '../../src/domain/library';

/** 这里**不** mock `nativeImageCache`：`tests/setup.ts` 会先预加载那几个页面
 * （ReaderRoute / DeduplicationWorkspace…），`ArchiveThumbnailCard` 因此在任何测试
 * 文件求值之前就拿到了共享缓存实例——测试文件里的 `vi.mock` 到那时已经晚了，卡片
 * 用的还是真的那一份（实测：组件侧缓存 memory.size = 0，mock 侧 = 1）。所以封面
 * 相关的断言改成「真的缓存 + 假的原生桥」：`setInvokeAdapterForTests` 就是桥的那
 * 个测试接口，测的正是卡片自己那条路。 */

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
 * every list reads as being at both ends at once. Pin what the gesture asks for.
 *
 * `overflow-y` is set inline because that is what the pull reads to find the
 * element it belongs to, and jsdom's getComputedStyle only sees inline styles
 * here — the app's stylesheet is not loaded in these tests. */
function scrollable(element: HTMLElement, metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { value, configurable: true, writable: true });
  }
  element.style.overflowY = 'auto';
}

describe('library workspace', () => {
  it('fades the first-load skeleton over the arriving cards', async () => {
    const view = renderWorkspace({ archives: [], listLoading: true });
    expect(screen.getByRole('status', { name: '正在读取档案' })).toBeInTheDocument();

    view.rerender(<MemoryRouter><LibraryWorkspace archives={[archives[0]!]} listLoading={false} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /^Archive 0\b/ })).toBeInTheDocument();
    expect(document.querySelector('.archive-list-skeleton.is-exiting')).not.toBeNull();
    await waitFor(() => expect(document.querySelector('.archive-list-skeleton')).toBeNull());
  });

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

  it('adds skeleton rows on tall viewports so the loading shell fills the height', () => {
    const original = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1600 });
    try {
      renderWorkspace({ archives: [], listLoading: true, cardStyle: 'wide' });
      // 1600px of viewport at a 158px row plus gap needs more than the 5-row floor.
      expect(document.querySelectorAll('.archive-row-skeleton').length).toBeGreaterThan(5);
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: original });
    }
  });

  it('distributes wide-card tags across three left-starting rows', () => {
    const tags = ['female:ta', 'female:tb', 'female:tc', 'female:td', 'female:te', 'female:tf'];
    renderWorkspace({ archives: [{ ...archives[0]!, tags }] });
    const rows = [...document.querySelectorAll('.archive-row-tag-line')];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [...row.querySelectorAll('.metadata-chip')].map((chip) => chip.textContent)))
      .toEqual([['ta', 'td'], ['tb', 'te'], ['tc', 'tf']]);
  });

  it('forgets the oldest wide-cover marks instead of growing with the library', () => {
    // The marks are one key per wide cover ever scrolled past, so they have to
    // fall out oldest-first; a set that only ever grows lives as long as the
    // workspace stays mounted. 4096 covers is not worth rendering in jsdom, so
    // the order is pinned on a smaller cap.
    expect(WIDE_COVER_MARK_LIMIT).toBe(4096);
    let marks = new Set<string>();
    for (const id of ['a', 'b', 'c', 'd', 'e']) marks = withWideCoverMark(marks, id, true, 3);
    expect([...marks]).toEqual(['c', 'd', 'e']);
    // Nothing moved: a fresh set per cover load would re-render the whole list.
    expect(withWideCoverMark(marks, 'd', true, 3)).toBe(marks);
    expect(withWideCoverMark(marks, 'z', false, 3)).toBe(marks);
    // A cover measured narrow loses its mark instead of holding a slot.
    marks = withWideCoverMark(marks, 'c', false, 3);
    expect([...marks]).toEqual(['d', 'e']);
    marks = withWideCoverMark(marks, 'f', true, 3);
    expect([...marks]).toEqual(['d', 'e', 'f']);
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

  it('gives each hour near the newest row its own tick, and merges the hours that share one', () => {
    renderWorkspace({
      archives: archives.slice(0, 3),
      timelineByArchiveId: new Map([
        // 同一小时里的两条（08:15 与 08:20）只发一个刻度：刻度代表的是「08 点」这一
        // 桶，落在桶里最新的那一行上。
        ['archive-0', { date: '2026-09-11', dayLabel: '今天', time: '08:15', at: Date.parse('2026-09-11T08:15:00+08:00') }],
        ['archive-1', { date: '2026-09-11', dayLabel: '今天', time: '08:20', at: Date.parse('2026-09-11T08:20:00+08:00') }],
        // 隔了近十个小时：另一个小时，另一个刻度。
        ['archive-2', { date: '2026-09-10', dayLabel: '昨天', time: '22:40', at: Date.parse('2026-09-10T22:40:00+08:00') }],
      ]),
    });

    const rail = screen.getByRole('group', { name: '历史快速跳转' });
    const ticks = [...rail.querySelectorAll<HTMLElement>('.archive-quick-rail-tick')];
    expect(ticks.map((tick) => tick.getAttribute('title'))).toEqual(['今天 08:15', '昨天 22:40']);
    expect(ticks.map((tick) => tick.getAttribute('aria-label'))).toEqual(['跳转到 今天 08:15', '跳转到 昨天 22:40']);
    // 第一条就是「正在看的那一行」；桌面端不再同时挂着日历下拉（两个入口挤在
    // 同一角会互相重叠）。
    expect(ticks[0]).toHaveClass('is-active');
    expect(ticks[0]).toHaveAttribute('aria-current', 'true');
    expect(ticks[1]).not.toHaveClass('is-active');

    // 刻度自己写着目标时间：title 要悬停才看得到，轨道上得能直接读出来。
    for (const tick of ticks) {
      const label = tick.querySelector<HTMLElement>('.archive-quick-rail-label');
      expect(label).not.toBeNull();
      expect(label).toHaveAttribute('aria-hidden', 'true');
      expect(label?.textContent).toBe(tick.getAttribute('title'));
    }
  });

  it('hangs the rail off the list panel instead of the scrolling list', () => {
    // 用户要求这条刻度带「垂直方向居中」。它原来住在滚动容器里面（sticky + 零高度
    // 浮动）：只能贴着列表可视区的顶边往下量一段距离，而「列表可视区有多高」在 CSS
    // 里根本量不到，于是它一直偏下；滚到列表底部时 sticky 还会被内容高度夹住往上漂。
    // 挂到列表外面的面板层上，`top: 50%` 量的就是列表可视高度本身 —— 既居中，也不
    // 再跟着滚动跑。刻度密度同理：过去是「N 个刻度摊满 48vh」，现在是固定 11px 一格。
    renderWorkspace({
      archives: archives.slice(0, 2),
      timelineByArchiveId: new Map([
        ['archive-0', { date: '2026-09-11', dayLabel: '今天', time: '08:15', at: Date.parse('2026-09-11T08:15:00+08:00') }],
        ['archive-1', { date: '2026-09-10', dayLabel: '昨天', time: '22:40', at: Date.parse('2026-09-10T22:40:00+08:00') }],
      ]),
    });

    const list = screen.getByRole('list', { name: '档案' });
    const rail = screen.getByRole('group', { name: '历史快速跳转' });
    expect(list.contains(rail)).toBe(false);
    expect(rail.parentElement).toHaveClass('library-list-panel-content');
    // 一格 11px 的节距得知道有几格，高度才算得出来。
    expect(rail.querySelector<HTMLElement>('.archive-quick-rail-track')?.style.getPropertyValue('--rail-ticks')).toBe('2');
  });

  it('leaves no quick-jump control behind in the compact layout', () => {
    // 紧凑档的轨线整列都不画，刻度条没有落点：过去的日历下拉按钮既跳不到「哪一天」，
    // 也和桌面端的入口重复。用户要求直接去掉，也不为紧凑档适配刻度条。
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === COMPACT_WIDTH_QUERY,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      renderWorkspace({
        archives: archives.slice(0, 3),
        timelineByArchiveId: new Map([
          ['archive-0', { date: '2026-09-11', dayLabel: '今天', time: '08:15', at: Date.parse('2026-09-11T08:15:00+08:00') }],
          ['archive-1', { date: '2026-08-02', dayLabel: '8月2日', time: '10:00', at: Date.parse('2026-08-02T10:00:00+08:00') }],
        ]),
      });

      expect(screen.queryByRole('button', { name: '跳转到历史时间' })).toBeNull();
      expect(screen.queryByRole('group', { name: '历史快速跳转' })).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it('falls back to one tick per day for callers that only send a date', () => {
    // 旧调用点只有 `date`，不知道「多久以前」，只能退到最粗的可信粒度「天」。
    renderWorkspace({
      archives: archives.slice(0, 3),
      timelineByArchiveId: new Map([
        ['archive-0', { date: '2026-09-11', dayLabel: '今天', time: '08:15' }],
        ['archive-1', { date: '2026-09-11', dayLabel: '今天', time: '09:30' }],
        ['archive-2', { date: '2026-09-10', dayLabel: '昨天', time: '22:40' }],
      ]),
    });

    const ticks = [...screen.getByRole('group', { name: '历史快速跳转' }).querySelectorAll<HTMLElement>('.archive-quick-rail-tick')];
    expect(ticks.map((tick) => tick.getAttribute('title'))).toEqual(['今天 08:15', '昨天 22:40']);
    expect(ticks.map((tick) => tick.getAttribute('aria-label'))).toEqual(['跳转到 今天 08:15', '跳转到 昨天 22:40']);
  });

  it('collapses the days far from the newest row into one coarse tick', () => {
    // 三个月前的十天挤进一个月刻度：远处的日子再多也不该占满轨道（它们本来也跳不
    // 到「哪一天」，只有「大概那时候」）。刻度落在这个桶最新的那一行上。
    const oldDays = Array.from({ length: 10 }, (_, offset) => `2026-06-${String(19 - offset).padStart(2, '0')}`);
    const timelineByArchiveId = new Map<string, { date: string; dayLabel: string; time: string; at: number }>([
      ['archive-0', { date: '2026-09-11', dayLabel: '今天', time: '08:15', at: Date.parse('2026-09-11T08:15:00+08:00') }],
      ...oldDays.map((date, offset): [string, { date: string; dayLabel: string; time: string; at: number }] => [
        `archive-${offset + 1}`,
        {
          date,
          dayLabel: `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`,
          time: '12:00',
          at: Date.parse(`${date}T12:00:00+08:00`),
        },
      ]),
    ]);
    renderWorkspace({ archives: archives.slice(0, 11), timelineByArchiveId });

    const ticks = [...screen.getByRole('group', { name: '历史快速跳转' }).querySelectorAll<HTMLElement>('.archive-quick-rail-tick')];
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toHaveAttribute('title', '今天 08:15');
    expect(ticks[1]).toHaveAttribute('title', '6月19日 12:00');
  });

  it('honours the tick budget by coarsening every bucket a tier', () => {
    // 120 行、每小时一行：按「小时」会发 25 个刻度，再叠上外面的「天」桶，超过上限，
    // 于是整体升一级（小时→天、天→周）重建。
    const hourly: ArchiveRecord[] = Array.from({ length: 120 }, (_, index) => ({
      ...archives[0]!,
      archiveId: `hourly-${index}`,
      title: `Hourly ${index}`,
    }));
    const anchorAt = Date.parse('2026-09-11T08:15:00+08:00');
    const pad = (part: number) => String(part).padStart(2, '0');
    const timelineByArchiveId = new Map(hourly.map((archive, index) => {
      const at = anchorAt - index * 3_600_000;
      const moment = new Date(at);
      return [archive.archiveId, {
        date: `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`,
        dayLabel: '9月11日',
        time: `${pad(moment.getHours())}:${pad(moment.getMinutes())}`,
        at,
      }];
    }));
    renderWorkspace({ archives: hourly, timelineByArchiveId });

    const ticks = [...screen.getByRole('group', { name: '历史快速跳转' }).querySelectorAll<HTMLElement>('.archive-quick-rail-tick')];
    expect(ticks.length).toBeLessThanOrEqual(RAIL_MAX_TICKS);
    // 是「升一级」而不是「抽稀」：整段历史只剩个位数个刻度，第一个还是最新的那行。
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThan(8);
    expect(ticks[0]).toHaveClass('is-active');
  });

  it('thins the ticks evenly when even year buckets overflow the budget', () => {
    // 极端旧历史：42 个不同年份，「年」已经是最粗的一级，只能等距抽稀。
    const years = Array.from({ length: 42 }, (_, index) => 2000 - index);
    const oldArchives: ArchiveRecord[] = years.map((_, index) => ({
      ...archives[0]!,
      archiveId: `old-${index}`,
      title: `Old ${index}`,
    }));
    const timelineByArchiveId = new Map(oldArchives.map((archive, index) => {
      const date = `${years[index]}-06-15`;
      return [archive.archiveId, {
        date,
        dayLabel: `${date.slice(0, 4)}年6月15日`,
        time: '12:00',
        at: Date.parse(`${date}T12:00:00+08:00`),
      }];
    }));
    renderWorkspace({ archives: oldArchives, timelineByArchiveId });

    const ticks = [...screen.getByRole('group', { name: '历史快速跳转' }).querySelectorAll<HTMLElement>('.archive-quick-rail-tick')];
    expect(ticks.length).toBeLessThanOrEqual(RAIL_MAX_TICKS);
    // ceil(42 / 20) = 3：每隔两个留一个。
    expect(ticks).toHaveLength(14);
  });

  it('caps the ticks by the measured panel height as well as the constant', () => {
    // 一格 18px、最多占面板的七成：面板只有 300px 高时轨道放得下 11 个刻度
    // （0.7 × 300 / 18），比常量上限（20）少——短窗口里 20 个刻度又会挤成密齿梯子，
    // 而密齿正是用户报「太密了根本用不了」的样子。42 个年份等距抽到 11 个：
    // ceil(42 / 11) = 4，每隔三个留一个。
    const original = window.ResizeObserver;
    const size = { blockSize: 300, inlineSize: 900 } as ResizeObserverSize;
    window.ResizeObserver = class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      disconnect(): void {}
      observe(target: Element): void {
        this.callback([{
          borderBoxSize: [size],
          contentBoxSize: [size],
          contentRect: { bottom: 300, height: 300, left: 0, right: 900, top: 0, width: 900, x: 0, y: 0, toJSON: () => ({}) },
          devicePixelContentBoxSize: [size],
          target,
        }], this);
      }
      unobserve(): void {}
    } as unknown as typeof ResizeObserver;
    try {
      const years = Array.from({ length: 42 }, (_, index) => 2000 - index);
      const oldArchives: ArchiveRecord[] = years.map((_, index) => ({
        ...archives[0]!,
        archiveId: `short-${index}`,
        title: `Short ${index}`,
      }));
      const timelineByArchiveId = new Map(oldArchives.map((archive, index) => {
        const date = `${years[index]}-06-15`;
        return [archive.archiveId, {
          date,
          dayLabel: `${date.slice(0, 4)}年6月15日`,
          time: '12:00',
          at: Date.parse(`${date}T12:00:00+08:00`),
        }];
      }));
      renderWorkspace({ archives: oldArchives, timelineByArchiveId });

      const ticks = [...screen.getByRole('group', { name: '历史快速跳转' }).querySelectorAll<HTMLElement>('.archive-quick-rail-tick')];
      expect(ticks).toHaveLength(11);
      expect(ticks.length).toBeLessThan(RAIL_MAX_TICKS);
    } finally {
      window.ResizeObserver = original;
    }
  });

  it('moves the rail’s filled tick when a tick is picked', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      archives: archives.slice(0, 3),
      timelineByArchiveId: new Map([
        ['archive-0', { date: '2026-09-11', dayLabel: '今天', time: '08:15', at: Date.parse('2026-09-11T08:15:00+08:00') }],
        ['archive-1', { date: '2026-09-11', dayLabel: '今天', time: '09:30', at: Date.parse('2026-09-11T09:30:00+08:00') }],
        ['archive-2', { date: '2026-09-10', dayLabel: '昨天', time: '22:40', at: Date.parse('2026-09-10T22:40:00+08:00') }],
      ]),
    });

    const ticks = [...screen.getByRole('group', { name: '历史快速跳转' }).querySelectorAll<HTMLElement>('.archive-quick-rail-tick')];
    await user.click(ticks[1]!);
    expect(ticks[1]).toHaveClass('is-active');
    expect(ticks[0]).not.toHaveClass('is-active');
  });

  it('pins the reading progress to the card’s own bottom edge', () => {    renderWorkspace({
      archives: archives.slice(0, 1),
      cardStyle: 'wide',
      readingProgressByArchiveId: new Map([['archive-0', 40]]),
    });

    const card = screen.getByRole('button', { name: /^Archive 0\b/ });
    const bar = card.querySelector<HTMLElement>('.archive-card-progress');
    // 贴卡片自己的底边：横条是卡片的直接子元素，卡片自己的 overflow: hidden +
    // border-radius 才能把两端削成与下缘一致的圆角（在文案栏里只能贴到文案栏
    // 的底边，两端是直角，右侧还差一个内边距）。
    expect(bar).not.toBeNull();
    expect(bar?.parentElement).toBe(card);
    expect(bar?.closest('.archive-row-copy')).toBeNull();
    expect(card.lastElementChild).toBe(bar);
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

  it('judges the gesture against the element that will actually scroll', async () => {
    const onRefresh = vi.fn();
    const view = renderWorkspace({ archives, onRefresh });
    const list = screen.getByRole('list', { name: '档案' });
    const pull = list.querySelector('.archive-list-pull') as HTMLElement;
    // 紧凑档的档案库：列表是全内容高度（clientHeight === scrollHeight），真正滚的是
    // 外面的 .workspace。挂载那一刻虚拟列表还没量出高度，宿主就被钉在了列表上，
    // 于是列表的 scrollTop 永远是 0 —— 按「既在顶又在底」判读，每一格滚轮都会被当成
    // 越过端点。这里把外面那层做成真正的滚动者、且停在列表中部。
    scrollable(list, { scrollTop: 0, clientHeight: 6036, scrollHeight: 6036 });
    scrollable(view.container, { scrollTop: 1000, clientHeight: 800, scrollHeight: 4000 });

    fireEvent.wheel(list, { deltaY: 120 });
    expect(pull).toHaveStyle({ transform: 'translateY(0px)' });
    fireEvent.wheel(list, { deltaY: -200 });
    expect(pull).toHaveStyle({ transform: 'translateY(0px)' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 260)));
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does not drag a list that cannot scroll when the wheel goes down', () => {
    // 内容一屏装得下时列表自己既是顶又是底；向下滚没有「底部」可越，只有向上那一下
    // 才是拉刷新。把它当成底部去拖，用户看到的就是每次滚轮都回弹一下。
    renderWorkspace({ archives: archives.slice(0, 3), onRefresh: () => {} });
    const list = screen.getByRole('list', { name: '档案' });
    const pull = list.querySelector('.archive-list-pull') as HTMLElement;
    scrollable(list, { scrollTop: 0, clientHeight: 6036, scrollHeight: 6036 });

    fireEvent.wheel(list, { deltaY: 120 });
    expect(pull).toHaveStyle({ transform: 'translateY(0px)' });
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

  it('pulls on the layouts where the page scrolls and the list does not', () => {
    // Compact and the shelves run the list at full content height and scroll the
    // page instead. Resolving the gesture to the list meant those layouts — the
    // ones with no other way to ask — had no pull at all.
    const onRefresh = vi.fn();
    renderWorkspace({ archives, onRefresh });
    const list = screen.getByRole('list', { name: '档案' });
    const pull = list.querySelector('.archive-list-pull') as HTMLElement;
    // The list may scroll but has nothing to scroll: it is exactly as tall as its
    // content, which is what makes it a container rather than a scroller.
    scrollable(list, { scrollTop: 0, clientHeight: 4000, scrollHeight: 4000 });
    const page = list.closest('.library-workspace')?.parentElement as HTMLElement;
    expect(page).toBeTruthy();
    scrollable(page, { scrollTop: 0, clientHeight: 800, scrollHeight: 4000 });
    // The pull resolves its scroller once per layout, the same way it does after
    // a rotation puts the app into the compact layout.
    fireEvent(window, new Event('resize'));

    fireEvent.wheel(page, { deltaY: -200 });
    // Half the travel, capped — the same damping the list gets.
    expect(pull).toHaveStyle({ transform: 'translateY(100px)' });
    fireEvent.wheel(page, { deltaY: 0 });

    fireEvent.touchStart(page, { touches: [{ clientY: 10 }] });
    fireEvent.touchMove(page, { touches: [{ clientY: 170 }] });
    expect(pull).toHaveStyle({ transform: 'translateY(80px)' });
    fireEvent.touchEnd(page);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // And the page keeps its own scrolling: an upward drag from the top is the
    // page moving, not a pull, so nothing is asked for.
    onRefresh.mockClear();
    page.scrollTop = 400;
    fireEvent.touchStart(page, { touches: [{ clientY: 400 }] });
    fireEvent.touchMove(page, { touches: [{ clientY: 300 }] });
    fireEvent.touchEnd(page);
    expect(onRefresh).not.toHaveBeenCalled();
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

  it('offers select-all-finished in the selection bar, and un-selects them on a second press', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderWorkspace({
      archives: archives.slice(0, 4),
      selectionMode: true,
      onSelectionChange,
      finishedArchiveIds: new Set(['archive-1', 'archive-3']),
    });

    const button = screen.getByRole('button', { name: '全选已读完' });
    await user.click(button);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['archive-1', 'archive-3']));
    // 选中态是按下态：再点一次取消，与「全选当前」同一个开关。
    expect(button).toHaveAttribute('aria-pressed', 'false');

    cleanup();
    renderWorkspace({
      archives: archives.slice(0, 4),
      selectionMode: true,
      selectedArchiveIds: new Set(['archive-1', 'archive-3']),
      onSelectionChange,
      finishedArchiveIds: new Set(['archive-1', 'archive-3']),
    });
    const pressed = screen.getByRole('button', { name: '取消全选已读完' });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');
    await user.click(pressed);
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());

    // 没有已读完条目时按钮被禁用而不是消失——多选里少一个动作比动作闪现清楚。
    cleanup();
    renderWorkspace({
      archives: archives.slice(0, 2),
      selectionMode: true,
      onSelectionChange,
      finishedArchiveIds: new Set(),
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

/** 切页时封面先闪一下骨架：两条独立的机制——重挂载要重走一次异步取图，以及宽/窄
 * 形状的判定只活在组件态里，路由一去一回就丢。这里把两条都钉在测试里。 */
describe('library cover flashes between pages', () => {
  // 宽标记是模块级的，会改变网格打包的行数，所以每个用例前后都清干净。
  beforeEach(() => resetWideCoverMarksForTests());
  afterEach(() => {
    resetWideCoverMarksForTests();
    resetInvokeAdapterForTests();
  });

  const coverIdentity = (archiveId: string) => ({
    scopeId: 'local',
    serverId: 'local',
    archiveId,
    rendition: 'cover' as const,
    pageIndex: 0,
  });

  const card = (archive: ArchiveRecord) => (
    <MemoryRouter><ArchiveThumbnailCard archive={archive} scopeId="local" serverId="local" /></MemoryRouter>
  );
  /** 原生桥：只有取封面这一条命令成功，别的（磁盘缓存查表等）都回「没有」，于是
   * 封面一定走一次真的取图、再进内存缓存。外部缓存的单例是跨用例共用的，所以每条
   * 用例用不同的 archiveId 避开上一条留下的那份。 */
  const serveCover = () => setInvokeAdapterForTests(async (command) => (command === 'load_archive_thumbnail'
    ? { ok: true, value: [1, 2, 3] }
    : { ok: false, error: { code: 'NOT_FOUND', message: '没有缓存副本', retryable: false } }));

  it('paints an already cached cover on the very first frame of a remount', async () => {
    serveCover();

    const first = render(card(archives[0]!));
    // 缓存是空的：第一帧还是占位块——但它是「还在等」的那一种，不是失败。
    const cold = first.container.querySelector('.archive-thumb-card-media .archive-thumb-card-skeleton');
    expect(cold).not.toBeNull();
    expect(cold?.className).not.toContain('is-failed');
    await waitFor(() => expect(first.container.querySelector('.archive-thumb-card-media img')).not.toBeNull());
    const url = first.container.querySelector('.archive-thumb-card-media img')?.getAttribute('src');
    expect(url).toBeTruthy();
    first.unmount();

    // 回到档案库：同一张封面，第一帧就得是图，不能先摆一个骨架。
    const second = render(card(archives[0]!));
    const media = second.container.querySelector('.archive-thumb-card-media');
    expect(media?.querySelector('.archive-thumb-card-skeleton')).toBeNull();
    expect(media?.querySelector('img')?.getAttribute('src')).toBe(url);
  });

  it('leaves an unavailable cover on the placeholder it showed before', async () => {
    // 取不到图（离线、服务器 202、图已删）时必须和从前一样：停在失败的占位块上，
    // 不因为「记下来的宽窄」而先排成宽卡。
    setInvokeAdapterForTests(async () => ({ ok: false, error: { code: 'UNKNOWN', message: '离线', retryable: true } }));

    const view = render(card(archives[1]!));

    await waitFor(() => expect(view.container.querySelector('.archive-thumb-card-skeleton.is-failed')).not.toBeNull());
    expect(view.container.querySelector('.archive-thumb-card-media img')).toBeNull();
    expect(view.container.querySelector('a.archive-thumb-card')?.className).not.toContain('is-wide');
  });

  it('shows a remembered wide cover as wide on the first frame', () => {
    rememberWideCoverMark('local', 'archive-3', true);

    const view = render(card(archives[3]!));

    expect(view.container.querySelector('a.archive-thumb-card')?.className).toContain('is-wide');
  });

  it('remembers the ratio a cover actually measured', async () => {
    serveCover();
    const view = render(card(archives[4]!));
    await waitFor(() => expect(view.container.querySelector('.archive-thumb-card-media img')).not.toBeNull());

    // jsdom 不加载图片，自然宽高比要自己摆上去；`onLoad` 是卡片拿到比例的唯一入口。
    const image = view.container.querySelector('.archive-thumb-card-media img')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 300 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 100 });
    fireEvent.load(image);

    expect(view.container.querySelector('a.archive-thumb-card')?.className).toContain('is-wide');
    // 记到了跨路由的那份记录上：同一个 archiveId 下次进来第一帧就是宽卡。
    expect(isWideCoverMarked('local', 'archive-4')).toBe(true);
  });

  it('packs the grid with remembered wide covers without waiting for a cover to load', () => {
    rememberWideCoverMark('local', 'archive-1', true);

    const view = renderWorkspace({ archives: archives.slice(0, 4), cardStyle: 'thumbnail' });

    const wide = view.container.querySelectorAll('.archive-row-wrap.is-cover-wide');
    expect(wide).toHaveLength(1);
    expect(wide[0]?.textContent).toContain('Archive 1');
  });

  it('keeps the cover on screen when the page hands back fresh records for the same archives', async () => {
    const onLoadThumbnail = vi.fn(async () => ({ key: 'cover:local:archive-0', url: 'blob:held-cover', bytes: 3 }));
    const onReleaseThumbnail = vi.fn();
    const view = renderWorkspace({ archives: archives.slice(0, 2), cardStyle: 'thumbnail', onLoadThumbnail, onReleaseThumbnail });
    await waitFor(() => expect(view.container.querySelectorAll('.archive-row-thumb img')).toHaveLength(2));

    // 回到前台时 LibraryRouteWorkspace 会在后台重读第一页：同样的档案、新的对象。
    view.rerender(
      <MemoryRouter>
        <LibraryWorkspace
          archives={archives.slice(0, 2).map((archive) => ({ ...archive }))}
          cardStyle="thumbnail"
          onLoadThumbnail={onLoadThumbnail}
          onReleaseThumbnail={onReleaseThumbnail}
        />
      </MemoryRouter>,
    );

    expect(view.container.querySelectorAll('.archive-row-thumb.is-skeleton')).toHaveLength(0);
    expect(view.container.querySelectorAll('.archive-row-thumb img')).toHaveLength(2);
    // 正在显示的那一帧没有被撤掉：刷新这一轮里，旧句柄要等新句柄接上才放手。
    expect(onReleaseThumbnail).not.toHaveBeenCalled();
    await waitFor(() => expect(onReleaseThumbnail).toHaveBeenCalledTimes(2));
    expect(view.container.querySelectorAll('.archive-row-thumb img')).toHaveLength(2);
    expect(view.container.querySelectorAll('.archive-row-thumb.is-skeleton')).toHaveLength(0);
  });
});
