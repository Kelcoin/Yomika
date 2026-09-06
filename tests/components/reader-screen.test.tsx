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
  it('scrolls continuous pages when keyboard navigation changes progress', () => {
    const onProgress = vi.fn();
    render(<MemoryRouter><ReaderScreen archiveId="continuous" title="Continuous" pages={pages} layout="webtoon" onProgress={onProgress} /></MemoryRouter>);
    const scroller = screen.getByRole('region', { name: '连续阅读' });
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageDown' });
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(onProgress).toHaveBeenLastCalledWith(1, { layout: 'webtoon', direction: 'ltr' });
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageUp' });
    expect(scroller.scrollTop).toBe(0);
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

  it('keeps pages either side loaded and releases only what is far away', async () => {
    const releasePage = vi.fn();
    // Twelve pages, opening at 0. Retention reaches a few pages past the fetch
    // window on purpose: with the two sets identical, stepping forward released
    // the page just left and stepping back re-downloaded it, so every turn cost a
    // fresh request.
    const many = Array.from({ length: 12 }, () => pages[0]!);
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={many} releasePage={releasePage} />
      </MemoryRouter>,
    );

    await vi.waitFor(() => expect(releasePage.mock.calls.length).toBeGreaterThan(0));
    const released = releasePage.mock.calls.map(([index]) => index as number);
    // Neighbours survive; only pages well past the window go.
    expect(released).not.toContain(0);
    expect(released).not.toContain(1);
    expect(released).not.toContain(4);
    expect(released).toContain(11);
  });

  it('uses the mouse wheel for zoom on paged reading canvas', () => {
    const { unmount, container } = renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    // A cancelled event is the proof that the page itself will not scroll:
    // React registers wheel listeners as passive, so this only holds while the
    // component binds its own non-passive listener.
    expect(fireEvent.wheel(reader, { deltaY: 120 })).toBe(false);
    // One transform on the track that carries all three slots, not one per image:
    // a double spread used to overlap because both pages scaled from their own
    // centre. The curve is multiplicative, so 120 units of wheel is
    // exp(-0.18) ≈ 0.835.
    const zoomed = () => container.querySelector('.reader-single, .reader-spread') as HTMLElement;
    expect(zoomed().getAttribute('style')).toMatch(/scale\(0\.83/);
    expect(screen.getByRole('img', { name: '第 1 页' }).getAttribute('style')).toBeNull();
    fireEvent.wheel(reader, { deltaY: -120 });
    // Coming back within 5% of 100% snaps exactly onto it.
    expect(zoomed()).toHaveStyle('transform: scale(1) translate(0px, 0px)');
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

    expect(onProgress).toHaveBeenCalledWith(1, { layout: 'auto', direction: 'rtl' });
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

    expect(onProgress).toHaveBeenCalledWith(2, { layout: 'auto', direction: 'ltr' });
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

    // Direction is a choice between two, not a switch that is on: the pressed
    // styling made the button look permanently hovered in right-to-left.
    expect(screen.getByRole('button', { name: '从左到右' })).not.toHaveAttribute('aria-pressed');
    await user.click(screen.getByRole('button', { name: '从左到右' }));
    expect(screen.getByRole('button', { name: '从右到左' })).toBeInTheDocument();
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

  it('swaps an enhanced page in without disturbing the zoom', () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} />
      </MemoryRouter>,
    );
    const zoomed = () => container.querySelector('.reader-single') as HTMLElement;

    fireEvent.wheel(screen.getByRole('main', { name: '漫画阅读器' }), { deltaY: 120 });
    expect(zoomed().style.transform).toMatch(/scale\(0\.83/);

    // The enhanced rendition arrives after the plain page and takes its place in
    // the same slot. It used to be awaited inside the page load instead, so
    // nothing was on screen until inference finished — and whatever replaced the
    // page threw the zoom away with it.
    rerender(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} derivedPages={new Map([[0, 'blob:enhanced-0']])} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0');
    expect(zoomed().style.transform).toMatch(/scale\(0\.83/);
  });

  it('asks for enhancement only for the pages on screen', async () => {
    const onVisiblePages = vi.fn();
    const many = Array.from({ length: 12 }, () => pages[0]!);
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={many} prefetchDistance={4} onVisiblePages={onVisiblePages} />
      </MemoryRouter>,
    );

    // The prefetch window is wider than the screen on purpose, but an ONNX run per
    // prefetched neighbour is what made the reader unusable with upscaling on.
    await vi.waitFor(() => expect(onVisiblePages).toHaveBeenCalled());
    expect(onVisiblePages).toHaveBeenLastCalledWith([0]);
  });

  it('renders both halves of a spread in double mode', () => {
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} layout="double" initialPage={1} />
      </MemoryRouter>,
    );

    // The cover opens alone, so page 2 is the start of the first pair. Both halves
    // have to be in the same element as the two-column grid: with the layout class
    // on the frame and the slots one level deeper, the columns applied to nothing.
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();
    expect(document.querySelector('.reader-spread')?.children).toHaveLength(2);
  });

  it('leaves zoom to the wheel and the double click rather than toolbar buttons', async () => {
    const user = userEvent.setup();
    renderReader();

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    // Four toolbar slots for what two gestures already do, on a bar that has to
    // hold the layout, direction and enhancement controls as well.
    expect(screen.queryByRole('button', { name: '放大' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '缩小' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重置缩放' })).not.toBeInTheDocument();
  });

  it('sends a double click back to the original scale from wherever the wheel left it', () => {
    const { container } = renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const zoomed = () => container.querySelector('.reader-single, .reader-spread') as HTMLElement;

    fireEvent.wheel(reader, { deltaY: -200 });
    expect(zoomed().style.transform).not.toContain('scale(1)');
    // It used to reset only once the scale had reached the double-tap target, so
    // anything in between was enlarged further instead.
    fireEvent.doubleClick(reader);
    expect(zoomed().style.transform).toContain('scale(1)');
  });

  it('switches the two enhancements from the toolbar and says when one has no model', async () => {
    const user = userEvent.setup();
    const toggleUpscale = vi.fn();
    render(
      <MemoryRouter>
        <ReaderScreen
          archiveId="a1"
          title="Test archive"
          pages={pages}
          upscale={{ configured: true, active: true, toggle: toggleUpscale }}
          decensor={{ configured: false, active: false, toggle: () => undefined }}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '关闭超分' }));
    expect(toggleUpscale).toHaveBeenCalledTimes(1);
    // With nothing installed the button says so instead of silently doing
    // nothing, which is how these went unverifiable from inside the reader.
    expect(screen.getByRole('button', { name: '去码：未选择模型包' })).toBeDisabled();
  });

  it('loads only a window of pages in continuous mode', async () => {
    const loadPage = vi.fn(async (index: number) => `blob:page-${index}`);
    const many = Array.from({ length: 60 }, () => '');
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={many} layout="webtoon" loadPage={loadPage} prefetchDistance={1} />
      </MemoryRouter>,
    );

    await vi.waitFor(() => expect(loadPage).toHaveBeenCalled());
    // Continuous mode used to call every page visible, so it asked for all sixty
    // at once — with an enhancement enabled, sixty ONNX runs. That is the freeze.
    expect(loadPage.mock.calls.length).toBeLessThan(10);
    expect(loadPage).toHaveBeenCalledWith(0);
    expect(loadPage).not.toHaveBeenCalledWith(59);
  });

  it('shows a page that has not arrived as loading rather than as a failure', async () => {
    let resolvePage: ((value: string | undefined) => void) | undefined;
    const loadPage = vi.fn(() => new Promise<string | undefined>((resolve) => { resolvePage = resolve; }));
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={['']} loadPage={loadPage} />
      </MemoryRouter>,
    );

    // The two used to share one branch, so turning to a page that had not come
    // back yet announced 页面加载失败 and then quietly showed the page.
    // One animation, no caption: the accessible name is where the words live now.
    expect(await screen.findByRole('status', { name: '正在加载' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    resolvePage?.('blob:page-0');
    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
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
