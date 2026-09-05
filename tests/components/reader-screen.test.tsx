import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { App } from '../../src/app/App';
import { ReaderScreen } from '../../src/components/ReaderScreen';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

const pages = [
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
];

function renderReader() {
  return render(
    <MemoryRouter>
      <ReaderScreen archiveId="a1" title="Test archive" pages={pages} />
    </MemoryRouter>,
  );
}

describe('reader screen', () => {
  it('remembers the pairing start for the archive', async () => {
    const user = userEvent.setup();
    const onProgress = vi.fn();
    const view = render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} layout="double" onProgress={onProgress} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '封面单独一页，点击与第二页并排' }));

    // The toggle does not move the page, so without its own watch the choice
    // would never be written and would reset the next time the archive opened.
    expect(onProgress).toHaveBeenCalledWith(0, { layout: 'double', direction: 'ltr', coverAlone: false });
    view.unmount();

    // Reopening with the stored value restores the pairing rather than the cover.
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} layout="double" coverAlone={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
  });

  it('lets the pairing start move off the cover', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} layout="double" />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    // The cover opens alone by default, as a printed book does.
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '第 2 页' })).not.toBeInTheDocument();

    // A scan carrying both inside-cover pages is off by one throughout, and with
    // no spread anywhere there is nothing to detect it from.
    await user.click(screen.getByRole('button', { name: '封面单独一页，点击与第二页并排' }));
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '封面与第二页并排，点击让封面单独一页' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows a page immediately and toggles one unified chrome', async () => {
    const user = userEvent.setup();
    renderReader();

    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: '阅读控制' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(screen.getByRole('toolbar', { name: '阅读控制' })).toBeInTheDocument();
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
  });

  it('supports keyboard paging without crossing bounds', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    fireEvent.keyDown(reader, { key: 'PageDown' });
    fireEvent.keyDown(reader, { key: 'PageDown' });
    expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();
    fireEvent.keyDown(reader, { key: 'ArrowLeft' });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
  });

  it('releases loaded pages outside the visible prefetch window', async () => {
    const releasePage = vi.fn();
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={[...pages, pages[0]!, pages[1]!]} releasePage={releasePage} />
      </MemoryRouter>,
    );

    await vi.waitFor(() => expect(releasePage.mock.calls.map(([index]) => index)).toEqual([2, 3, 4]));
  });

  it('uses the mouse wheel for zoom on paged reading canvas', () => {
    const { unmount } = renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    // A cancelled event is the proof that the page itself will not scroll:
    // React registers wheel listeners as passive, so this only holds while the
    // component binds its own non-passive listener.
    expect(fireEvent.wheel(reader, { deltaY: 120 })).toBe(false);
    // One transform on the spread, not one per image: a double spread used to
    // overlap because both pages scaled from their own centre. The curve is
    // multiplicative, so 120 units of wheel is exp(-0.18) ≈ 0.835.
    const spread = screen.getByRole('region', { name: '分页阅读' });
    expect(spread.getAttribute('style')).toMatch(/scale\(0\.83/);
    expect(screen.getByRole('img', { name: '第 1 页' }).getAttribute('style')).toBeNull();
    fireEvent.wheel(reader, { deltaY: -120 });
    // Coming back within 5% of 100% snaps exactly onto it.
    expect(spread).toHaveStyle('transform: scale(1) translate(0px, 0px)');
    const horizontalScroller = document.createElement('div');
    horizontalScroller.className = 'horizontal-scroller';
    reader.append(horizontalScroller);

    expect(fireEvent.wheel(horizontalScroller, { deltaY: 120 })).toBe(true);
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();

    unmount();
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} layout="webtoon" />
      </MemoryRouter>,
    );
    expect(fireEvent.wheel(screen.getByRole('main', { name: '漫画阅读器' }), { deltaY: 120 })).toBe(true);
    expect(screen.getByRole('region', { name: '连续阅读' })).toBeInTheDocument();
  });

  it('toggles the chrome from a tap in continuous mode, but not from a drag', () => {
    // `detail: 1` on purpose: two clicks in quick succession are a double click,
    // which zooms instead, and that path is asserted elsewhere.
    const tap = (from: [number, number], to = from) => {
      const main = screen.getByRole('main', { name: '漫画阅读器' });
      fireEvent.mouseDown(main, { button: 0, clientX: from[0], clientY: from[1] });
      fireEvent.mouseUp(main, { button: 0, clientX: to[0], clientY: to[1] });
      fireEvent.click(screen.getByRole('region', { name: '连续阅读' }), { detail: 1 });
    };

    const view = render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} layout="webtoon" />
      </MemoryRouter>,
    );
    // The section used to carry its own toggle as well as bubbling to the canvas,
    // so every click flipped twice and cancelled out — the chrome could not be
    // summoned in this mode at all.
    tap([200, 400]);
    expect(screen.getByRole('toolbar', { name: '阅读控制' })).toBeInTheDocument();
    view.unmount();

    // Drag-scrolling with a mouse ends in a click. Travel past a few pixels means
    // it was a scroll, not a tap on the page.
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} layout="webtoon" />
      </MemoryRouter>,
    );
    tap([200, 400], [205, 250]);
    expect(screen.queryByRole('toolbar', { name: '阅读控制' })).not.toBeInTheDocument();
  });

  it('owns focus on mount so arrow keys page without a chrome-toggling click', () => {
    renderReader();

    expect(screen.getByRole('main', { name: '漫画阅读器' })).toHaveFocus();
    expect(screen.queryByRole('toolbar', { name: '阅读控制' })).not.toBeInTheDocument();
  });

  it('reports progress with the active layout and direction for every kind of page change', async () => {
    const user = userEvent.setup();
    const onProgress = vi.fn();
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} onProgress={onProgress} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '从左到右' }));
    await user.click(screen.getByRole('button', { name: '上一页' }));

    expect(onProgress).toHaveBeenCalledWith(1, { layout: 'auto', direction: 'rtl', coverAlone: true });
  });

  it('records progress and keeps the chrome open when jumping from the thumbnail panel', async () => {
    const user = userEvent.setup();
    const onProgress = vi.fn();
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} onProgress={onProgress} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '缩略面板' }));
    await user.click(screen.getByRole('button', { name: '跳转到第 3 页' }));

    expect(onProgress).toHaveBeenCalledWith(2, { layout: 'auto', direction: 'ltr', coverAlone: true });
    expect(screen.getByRole('toolbar', { name: '阅读控制' })).toBeInTheDocument();
  });

  it('previews the thumbnail panel with the small rendition instead of pinning every full page', async () => {
    const user = userEvent.setup();
    const loadPage = vi.fn(async (_pageIndex: number) => undefined);
    const loadPageThumbnail = vi.fn(async (index: number) => `thumb-${index}`);
    render(
      <MemoryRouter>
        <ReaderScreen
          archiveId="a1"
          title="Test archive"
          pages={[pages[0]!, '', '', '', '']}
          loadPage={loadPage}
          loadPageThumbnail={loadPageThumbnail}
          releasePage={vi.fn()}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '缩略面板' }));

    await vi.waitFor(() => expect(loadPageThumbnail.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3, 4]));
    // Only the prefetch window may be fetched at full size, never the whole archive.
    expect(loadPage.mock.calls.map(([index]) => index)).toEqual([1]);
  });

  it('turns pages with a pointer drag on desktop', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    // Windows drags arrive as mouse events, so paging cannot rely on touch only.
    fireEvent.mouseDown(reader, { button: 0, clientX: 400, clientY: 200 });
    fireEvent.mouseUp(reader, { button: 0, clientX: 200, clientY: 210 });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();

    fireEvent.mouseDown(reader, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.mouseUp(reader, { button: 0, clientX: 400, clientY: 205 });
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();

    // A press without sideways travel is a tap, not a page turn.
    fireEvent.mouseDown(reader, { button: 0, clientX: 300, clientY: 200 });
    fireEvent.mouseUp(reader, { button: 0, clientX: 305, clientY: 200 });
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  });

  it('opens the overview panel in the centre with archive facts', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReaderScreen
          archiveId="a1"
          title="Test archive"
          pages={pages}
          info={{ tags: ['female:big breasts', 'language:chinese'], sizeBytes: 5 * 1024 * 1024 }}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '缩略面板' }));

    const overview = screen.getByRole('complementary', { name: '档案概览' });
    expect(overview).toBeInTheDocument();
    expect(within(overview).getByText('3 页 · 5.0 MB')).toBeInTheDocument();
    expect(within(overview).getByText(/big breasts|巨乳/)).toBeInTheDocument();
    // Jumping from the panel closes it and moves the reader.
    await user.click(within(overview).getByRole('button', { name: '跳转到第 3 页' }));
    expect(screen.queryByRole('complementary', { name: '档案概览' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();
  });

  it('renders double pages and webtoon pages as distinct layouts', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} layout="double" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '第 2 页' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();
    // One layout control, cycling 自动 → 单页 → 双页 → webtoon: from 双页 the next
    // press lands on continuous scrolling.
    await user.click(screen.getByRole('button', { name: '阅读布局：双页，点击切换' }));
    expect(screen.getByRole('region', { name: '连续阅读' })).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(3);
  });

  it('uses icons for every chrome control, no text buttons', async () => {
    const user = userEvent.setup();
    renderReader();
    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));

    const toolbar = screen.getByRole('toolbar', { name: '阅读控制' });
    for (const button of within(toolbar).getAllByRole('button')) {
      expect(button.querySelector('svg')).toBeTruthy();
      expect(button.textContent?.trim()).toBe('');
    }
  });

  it('cycles the reader layout from one control and toggles direction', async () => {
    const user = userEvent.setup();
    renderReader();
    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));

    // Three buttons spent three toolbar slots on one choice, and none of them
    // could get back to 自动 once it had been left.
    const layoutButton = () => screen.getByRole('button', { name: /^阅读布局：/ });
    expect(layoutButton()).toHaveAccessibleName('阅读布局：自动，点击切换');
    await user.click(layoutButton());
    expect(layoutButton()).toHaveAccessibleName('阅读布局：单页，点击切换');
    await user.click(layoutButton());
    expect(layoutButton()).toHaveAccessibleName('阅读布局：双页，点击切换');
    await user.click(layoutButton());
    expect(layoutButton()).toHaveAccessibleName('阅读布局：连续滚动，点击切换');
    await user.click(layoutButton());
    expect(layoutButton()).toHaveAccessibleName('阅读布局：自动，点击切换');

    // Right-to-left is the toggled-on state; the button used to always claim pressed.
    expect(screen.getByRole('button', { name: '从左到右' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: '从左到右' }));
    expect(screen.getByRole('button', { name: '从右到左' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('resolves auto layout to a double spread on wide portrait pages', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    renderReader();
    const first = screen.getByRole('img', { name: '第 1 页' });
    Object.defineProperty(first, 'naturalWidth', { configurable: true, value: 700 });
    Object.defineProperty(first, 'naturalHeight', { configurable: true, value: 1000 });
    fireEvent.load(first);
    expect(screen.queryByRole('img', { name: '第 2 页' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'ArrowRight' });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
  });

  it('uses a shell-free route for reading', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'archive-1', title: 'Reader', pages: ['00.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'load_reader_page') return { ok: true, value: [1] };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(
      <MemoryRouter initialEntries={['/reader/archive-1']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('navigation', { name: '主导航' })).not.toBeInTheDocument();
    expect(await screen.findByRole('main', { name: '漫画阅读器' })).toBeInTheDocument();
  });

  it('shows zoom controls in the toolbar and resets zoom', async () => {
    const user = userEvent.setup();
    renderReader();

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(screen.getByRole('button', { name: '放大' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '缩小' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重置缩放' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByRole('button', { name: '重置缩放' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重置缩放' }));
    expect(screen.queryByRole('button', { name: '重置缩放' })).not.toBeInTheDocument();
  });

  it('toggles zoom via toolbar buttons and shows zoom percentage', async () => {
    const user = userEvent.setup();
    renderReader();

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(screen.queryByRole('button', { name: '重置缩放' })).not.toBeInTheDocument();

    // Steps are multiplicative (x1.25), so repeated presses feel even instead of
    // jumping in fixed 50% increments.
    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByRole('button', { name: '重置缩放' })).toBeInTheDocument();
    expect(screen.getByText('125%')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByText('156%')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重置缩放' }));
    expect(screen.queryByRole('button', { name: '重置缩放' })).not.toBeInTheDocument();
    expect(screen.queryByText('125%')).not.toBeInTheDocument();
  });

  it('clamps zoom to maximum and minimum via buttons', async () => {
    const user = userEvent.setup();
    renderReader();

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    const zoomIn = screen.getByRole('button', { name: '放大' });

    for (let i = 0; i < 10; i++) {
      await user.click(zoomIn);
    }

    expect(screen.getByRole('button', { name: '重置缩放' })).toBeInTheDocument();
    expect(screen.getByText('300%')).toBeInTheDocument();

    const zoomOut = screen.getByRole('button', { name: '缩小' });
    for (let i = 0; i < 20; i++) {
      await user.click(zoomOut);
    }

    expect(screen.queryByRole('button', { name: '重置缩放' })).not.toBeInTheDocument();

    // Back above 100% the readout returns; the exact stop depends on the ratio,
    // so assert the invariant rather than a magic number.
    for (let i = 0; i < 4; i++) {
      await user.click(zoomIn);
    }
    expect(screen.getByRole('button', { name: '重置缩放' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重置缩放' }));
    expect(screen.queryByRole('button', { name: '重置缩放' })).not.toBeInTheDocument();
  });

  it('navigates pages via horizontal swipe gestures', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    fireEvent.touchStart(reader, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchEnd(reader, { changedTouches: [{ clientX: 50, clientY: 100 }] });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();

    fireEvent.touchStart(reader, { touches: [{ clientX: 50, clientY: 100 }] });
    fireEvent.touchEnd(reader, { changedTouches: [{ clientX: 200, clientY: 100 }] });
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  });

  it('ignores short swipes below the threshold', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    fireEvent.touchStart(reader, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(reader, { changedTouches: [{ clientX: 90, clientY: 100 }] });
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  });

  it('enters and exits fullscreen via toolbar button', async () => {
    let fullscreenElement: Element | null = null;
    const requestFullscreen = vi.fn(() => { fullscreenElement = document.documentElement; return Promise.resolve(); });
    const exitFullscreen = vi.fn(() => { fullscreenElement = null; return Promise.resolve(); });
    Object.defineProperty(document, 'fullscreenElement', { get: () => fullscreenElement, configurable: true });
    document.documentElement.requestFullscreen = requestFullscreen;
    document.exitFullscreen = exitFullscreen;

    const user = userEvent.setup();
    renderReader();

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(screen.getByRole('button', { name: '全屏' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '全屏' }));
    expect(requestFullscreen).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '全屏' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出全屏' })).toBeInTheDocument();

    fullscreenElement = document.documentElement;
    await user.click(screen.getByRole('button', { name: '退出全屏' }));
    expect(exitFullscreen).toHaveBeenCalled();
  });
});
