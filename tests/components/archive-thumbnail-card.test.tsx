import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('../../src/lib/nativeImageCache', () => ({
  getNativeImageCache: () => ({
    load: vi.fn().mockRejectedValue(new Error('cover unavailable in component test')),
    release: vi.fn(),
  }),
}));

import { ArchiveProgressBar, ArchiveThumbnailCard, ArchiveThumbnailRail } from '../../src/components/ArchiveThumbnailCard';

it('keeps one read page out of 259 visible without rounding it to zero', () => {
  const { container } = render(<ArchiveProgressBar page={1} pageCount={259} visibility="all" />);
  expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  expect(container.querySelector<HTMLElement>('.archive-card-progress-fill')?.style.width).toContain('6px');
});

/** jsdom 不做布局：轨道宽度只能由测试自己报给组件。观察谁、报多少，都由测试决定。 */
function installTrackResizeFake() {
  const original = window.ResizeObserver;
  const callbacks = new Map<Element, ResizeObserverCallback>();
  class FakeResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) { callbacks.set(target, this.callback); }
    unobserve(target: Element) { callbacks.delete(target); }
    disconnect() { callbacks.clear(); }
  }
  window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  return {
    reportWidth(target: Element, width: number) {
      Object.defineProperty(target, 'clientWidth', { configurable: true, value: width });
      const callback = callbacks.get(target);
      if (!callback) throw new Error('组件没有观察这条轨道');
      callback([{ target } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    },
    restore() { window.ResizeObserver = original; },
  };
}

describe('archive thumbnail card', () => {
  it('keeps the page count clear of decorative navigation icons', () => {
    const { container } = render(
      <MemoryRouter>
        <ArchiveThumbnailCard
          archive={{
            serverId: 'server-a',
            archiveId: 'archive-a',
            title: 'Archive A',
            pageCount: 169,
            updatedAt: '2026-09-02T00:00:00Z',
            addedAt: 1_760_742_000,
            tags: ['language:chinese'],
          }}
          scopeId="scope-a"
          serverId="server-a"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('169 页')).toBeInTheDocument();
    expect(container.querySelector('.archive-thumb-card-body > svg')).toBeNull();
  });

  it('links to the detail page on the server the archive came from', () => {
    // Two configured servers: a card must carry its own source server, or the
    // detail page (and from it the reader) opens the archive against the
    // first one — the wrong content when archive ids collide.
    render(
      <MemoryRouter>
        <ArchiveThumbnailCard
          archive={{
            serverId: 'server-b',
            archiveId: 'archive-b',
            title: 'Archive B',
            pageCount: 12,
            updatedAt: '2026-09-02T00:00:00Z',
            addedAt: 1_760_742_000,
            tags: [],
          }}
          scopeId="scope-b"
          serverId="server-b"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /Archive B/ })).toHaveAttribute(
      'href',
      '/library/archive-b?server=server-b',
    );
  });
});

describe('ArchiveProgressBar', () => {
  it('writes the fill as a length so a narrowing column animates', () => {
    // 打开详情页会让档案库的列变窄。填充只有写成绝对长度，`transition: width` 才有得
    // 插值——百分比的计算值就是百分比自己，列宽变化时前后一模一样，CSS 过渡直接跳过
    // （用户报的「打开详情页导致档案库变窄，此时进度条长度会发生变化，为这个变化加上动画」）。
    const fake = installTrackResizeFake();
    try {
      render(<ArchiveProgressBar page={45} pageCount={100} visibility="all" />);
      const track = document.querySelector('.archive-card-progress');
      const fill = document.querySelector<HTMLElement>('.archive-card-progress-fill');
      if (!track || !fill) throw new Error('进度条没有渲染出轨道和填充');

      act(() => fake.reportWidth(track, 200));
      expect(fill.style.width).toBe('90px');

      act(() => fake.reportWidth(track, 140));
      expect(fill.style.width).toBe('63px');
    } finally {
      fake.restore();
    }
  });

  it('leaves a card with no reading position bare, even in the 全部档案 mode', () => {
    // 用户报的「全部档案卡片都显示有进度条，哪怕没阅读过」：`all` 档原来只按档位放行，
    // 没读过的卡（`page` 是 null/undefined）也被画上一条 0% 的空条。
    const { container, rerender } = render(<ArchiveProgressBar page={null} pageCount={100} visibility="all" />);
    expect(container.querySelector('.archive-card-progress')).toBeNull();

    rerender(<ArchiveProgressBar page={undefined} pageCount={100} visibility="all" />);
    expect(container.querySelector('.archive-card-progress')).toBeNull();

    // 「读过 0 页」不算读过：页号是 1 起算的。
    rerender(<ArchiveProgressBar page={0} pageCount={100} visibility="all" />);
    expect(container.querySelector('.archive-card-progress')).toBeNull();

    // 至少读过一页才有进度可说，比例仍按页号算。
    rerender(<ArchiveProgressBar page={1} pageCount={100} visibility="all" />);
    const bar = container.querySelector('.archive-card-progress');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('aria-valuenow')).toBe('1');

    // 「不显示」这一档什么都不画。
    rerender(<ArchiveProgressBar page={50} pageCount={100} visibility="none" />);
    expect(container.querySelector('.archive-card-progress')).toBeNull();
  });

  it('draws the bar only where 仅历史记录 covers, and everywhere under 全部档案', () => {
    // 用户的原话：「仅历史记录是指仅在首页历史记录组件和历史记录页面内显示进度条，全部是指
    // 所有有进度的不管在什么页面都显示进度条」。没有 PreferencesContext 时档位取默认值
    // （`history`），正好用来量这条位置口径：位置由调用方的 `scope` 说，不由组件猜路由。
    const { container, rerender } = render(<ArchiveProgressBar page={50} pageCount={100} scope="history" />);
    expect(container.querySelector('.archive-card-progress')).not.toBeNull();

    // 档案库、待看、随机漫游、推荐这些位置在「仅历史记录」档下一条都不画。
    rerender(<ArchiveProgressBar page={50} pageCount={100} />);
    expect(container.querySelector('.archive-card-progress')).toBeNull();
    rerender(<ArchiveProgressBar page={50} pageCount={100} scope="elsewhere" />);
    expect(container.querySelector('.archive-card-progress')).toBeNull();

    // 「全部档案」照旧：哪儿有进度就在哪儿画。
    rerender(<ArchiveProgressBar page={50} pageCount={100} visibility="all" scope="elsewhere" />);
    expect(container.querySelector('.archive-card-progress')).not.toBeNull();
  });
});


it('keeps rail snap targets outside the cards that animate on press', () => {
  const archive = { serverId: 'server', archiveId: 'rail-a', title: 'Rail A', pageCount: 10, updatedAt: '', tags: [] };
  const { container } = render(<MemoryRouter><ArchiveThumbnailRail title="Rail" archives={[archive]} scopeId="scope" serverId="server" /></MemoryRouter>);
  const card = container.querySelector('.archive-thumb-card')!;
  expect(card.parentElement).toHaveClass('archive-rail-item');
  expect(card.parentElement?.parentElement).toHaveClass('archive-rail-grid');
});
