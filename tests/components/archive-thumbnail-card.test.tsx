import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('../../src/lib/nativeImageCache', () => ({
  getNativeImageCache: () => ({
    load: vi.fn().mockRejectedValue(new Error('cover unavailable in component test')),
    release: vi.fn(),
  }),
}));

import { ArchiveProgressBar, ArchiveThumbnailCard } from '../../src/components/ArchiveThumbnailCard';

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
});
