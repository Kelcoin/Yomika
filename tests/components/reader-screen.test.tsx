import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import { App } from '../../src/app/App';
import { ReaderScreen } from '../../src/components/ReaderScreen';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { setImageDecoderForTests } from '../../src/lib/decodeImage';

afterEach(resetInvokeAdapterForTests);

// `auto` resolves from the viewport, so the viewport is an input every test here
// has to state. jsdom's default is 1024×768 — wide enough for a spread — which
// would quietly turn most of these single-page gestures into spread gestures.
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
});

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
  it('keeps the plain page on screen until the processed one is decoded', async () => {
    // 超分/去码算完是**同一页换 src**：浏览器在换的那一帧会先把旧图扔掉（旧图 → 空 → 新图），
    // 阅读器底是深的，中间那一帧空档就是用户看到的黑闪。所以新图先解码，解好了才换上去。
    let release: (() => void) | undefined;
    setImageDecoderForTests(() => new Promise<void>((resolve) => { release = resolve; }));
    const plain = 'data:image/gif;base64,plain';
    const enhanced = 'data:image/gif;base64,enhanced';
    const view = render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={[plain]} derivedPages={new Map()} />
      </MemoryRouter>,
    );
    try {
      const image = await screen.findByRole('img', { name: '第 1 页' });
      expect(image).toHaveAttribute('src', plain);

      view.rerender(
        <MemoryRouter>
          <ReaderScreen archiveId="a1" title="Test archive" pages={[plain]} derivedPages={new Map([[0, enhanced]])} />
        </MemoryRouter>,
      );
      // 还没解完：屏幕上仍然是原图——不是空的那一帧。
      expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', plain);

      await act(async () => { release?.(); });
      await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', enhanced));
    } finally {
      setImageDecoderForTests(undefined);
    }
  });

  it('continues panning with the remaining finger after a pinch', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
    const x = window.innerWidth / 2;
    const y = window.innerHeight / 2;
    fireEvent.touchStart(reader, { touches: [{ clientX: x - 50, clientY: y }, { clientX: x + 50, clientY: y }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: x - 100, clientY: y }, { clientX: x + 100, clientY: y }] });
    fireEvent.touchEnd(reader, { touches: [{ clientX: x - 100, clientY: y }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: x, clientY: y + 40 }] });
    expect(frame.style.transform).toBe('scale(2) translate(50px, 20px)');
    expect(frame.style.transition).toBe('none');
    fireEvent.touchEnd(reader, { touches: [] });
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  });

  it('cancels a captured mouse swipe without changing page', () => {
    vi.useFakeTimers();
    const view = renderReader();
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      const track = reader.querySelector('.reader-track') as HTMLElement;
      fireEvent.mouseDown(reader, { button: 0, clientX: 500, clientY: 300 });
      fireEvent.mouseMove(reader, { buttons: 1, clientX: 200, clientY: 300 });
      act(() => vi.advanceTimersByTime(20));
      expect(track.style.transform).toBe('translate3d(-300px,0,0)');
      fireEvent.pointerCancel(reader);
      fireEvent.mouseUp(reader, { button: 0, clientX: 100, clientY: 300 });
      expect(track.style.transform).toBe('translate3d(0,0,0)');
      expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it('pans an enlarged page without paging and disables transform easing during drag', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
    fireEvent.doubleClick(reader);
    fireEvent.mouseDown(reader, { button: 0, clientX: 300, clientY: 300 });
    fireEvent.mouseMove(reader, { buttons: 1, clientX: 400, clientY: 360 });
    expect(frame.style.transform).toBe('scale(2) translate(50px, 30px)');
    expect(frame.style.transition).toBe('none');
    fireEvent.mouseUp(reader, { button: 0, clientX: 400, clientY: 360 });
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  });

  it('zooms about the midpoint of two fingers and springs undershoot back', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
    const y = window.innerHeight / 2;
    const x = window.innerWidth / 2 + 100;
    fireEvent.touchStart(reader, { touches: [{ clientX: x - 50, clientY: y }, { clientX: x + 50, clientY: y }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: x - 100, clientY: y }, { clientX: x + 100, clientY: y }] });
    expect(frame.style.transform).toBe('scale(2) translate(-50px, 0px)');
    fireEvent.touchMove(reader, { touches: [{ clientX: x - 20, clientY: y }, { clientX: x + 20, clientY: y }] });
    expect(frame.style.transform).toContain('scale(0.88)');
    fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: x - 20, clientY: y }] });
    expect(frame.style.transform).toBe('scale(1) translate(0px, 0px)');
  });

  it('reveals the toolbar at the hovered edge only', async () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.mouseMove(reader, { buttons: 0, clientY: 110 });
    expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    fireEvent.mouseMove(reader, { buttons: 0, clientY: window.innerHeight - 110 });
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument());
    fireEvent.mouseMove(reader, { buttons: 0, clientY: window.innerHeight / 2 });
    await vi.waitFor(() => expect(screen.queryByRole('toolbar')).not.toBeInTheDocument());
  });

  it('clears a pending swipe when a second finger joins', () => {
    vi.useFakeTimers();
    const view = renderReader();
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      const track = reader.querySelector('.reader-track') as HTMLElement;
      fireEvent.touchStart(reader, { touches: [{ clientX: 400, clientY: 300 }] });
      fireEvent.touchMove(reader, { touches: [{ clientX: 300, clientY: 300 }] });
      act(() => vi.advanceTimersByTime(20));
      expect(track.style.transform).toBe('translate3d(-100px,0,0)');
      fireEvent.touchStart(reader, { touches: [{ clientX: 300, clientY: 300 }, { clientX: 500, clientY: 300 }] });
      act(() => vi.advanceTimersByTime(250));
      expect(track.style.transform).toBe('translate3d(0,0,0)');
      expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it('does not start a page swipe from a toolbar control', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    const button = screen.getByRole('button', { name: '全屏' });
    fireEvent.mouseDown(button, { button: 0, clientX: 500, clientY: 700 });
    fireEvent.mouseMove(reader, { buttons: 1, clientX: 100, clientY: 700 });
    fireEvent.mouseUp(reader, { button: 0, clientX: 100, clientY: 700 });
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  });

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
    expect(within(screen.getByRole('toolbar', { name: '阅读控制' })).getByText('1 / 3')).toBeInTheDocument();
  });

  it('pins the page indicator outside the auto-hiding chrome', async () => {
    const user = userEvent.setup();
    renderReader();

    // The pill reads the on-screen pages and survives the chrome hiding again,
    // unlike the toolbar counter that comes and goes with it.
    expect(document.querySelector('.reader-page-indicator')?.textContent).toBe('1 / 3');
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'ArrowRight' });
    expect(document.querySelector('.reader-page-indicator')?.textContent).toBe('2 / 3');
    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(document.querySelector('.reader-page-indicator')?.textContent).toBe('2 / 3');
  });

  it('does not mount window controls outside the tauri shell', () => {
    renderReader();
    expect(screen.queryByRole('button', { name: '最大化窗口' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '还原窗口' })).not.toBeInTheDocument();
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
    expect(zoomed().getAttribute('style')).toMatch(/scale\(0\.96/);
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

  it('finishes the slide before replacing the current page', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const track = reader.querySelector('.reader-track') as HTMLDivElement;
    const animation = { cancel: vi.fn(), onfinish: undefined as (() => void) | undefined };
    const animate = vi.fn(() => animation);
    Object.defineProperty(track, 'animate', { value: animate, configurable: true });
    fireEvent.mouseDown(reader, { button: 0, clientX: 600, clientY: 200 });
    fireEvent.mouseMove(reader, { buttons: 1, clientX: 300, clientY: 200 });
    fireEvent.mouseUp(reader, { button: 0, clientX: 300, clientY: 200 });
    expect(animate).toHaveBeenCalledWith([
      { transform: 'translate3d(-300px,0,0)' },
      { transform: `translate3d(${-window.innerWidth}px,0,0)` },
    ], expect.objectContaining({ duration: 240 }));
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    act(() => animation.onfinish?.());
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    expect(track.style.transform).toBe('translate3d(0,0,0)');
  });

  it('allows a damped undershoot but settles back to 100 percent', () => {
    vi.useFakeTimers();
    const view = renderReader();
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
      fireEvent.wheel(reader, { deltaY: 120 });
      expect(frame.style.transform).toMatch(/scale\(0\.96/);
      act(() => vi.advanceTimersByTime(180));
      expect(frame.style.transform).toContain('scale(1)');
    } finally { view.unmount(); vi.useRealTimers(); }
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
    // Page count and size are the detail page's two facts, with its glyphs, rather
    // than a "3 页 · 5.0 MB" line of the panel's own.
    expect(within(overview).getByText('3 页')).toBeInTheDocument();
    expect(within(overview).getByText('5.0 MB')).toBeInTheDocument();
    expect(overview.querySelectorAll('.reader-overview-stats > div')).toHaveLength(2);
    expect(overview.querySelectorAll('.reader-overview-stats dt svg')).toHaveLength(2);
    expect(within(overview).getByText(/big breasts|巨乳/)).toBeInTheDocument();
    // Jumping from the panel closes it and moves the reader.
    await user.click(within(overview).getByRole('button', { name: '跳转到第 3 页' }));
    expect(screen.queryByRole('complementary', { name: '档案概览' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();
  });

  it('links overview tags to an exact library search', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} info={{ tags: ['female:big breasts'] }} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '缩略面板' }));

    expect(screen.getByRole('link', { name: /搜索标签 (big breasts|巨乳)/ })).toHaveAttribute(
      'href',
      '/library?q=female%3Abig+breasts%24%2C+',
    );
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

  it('resolves auto layout to a double spread on a wide viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    renderReader();
    expect(screen.queryByRole('img', { name: '第 2 页' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'ArrowRight' });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    // A pair, not just the next page: the wide viewport is the whole question, and
    // it is answered before any image has decoded.
    expect(document.querySelector('.reader-spread')?.children).toHaveLength(2);
  });

  it('has the incoming spread ready before the swipe lands', () => {
    // The layout was resolved from the page on screen and held globally, so the
    // frame a swipe reveals was built from the *outgoing* page's answer: leaving a
    // landscape scan towards a pair rendered the incoming frame as a single page
    // and only re-rendered it as a spread once the turn committed, which is the
    // spread appearing after the swipe instead of during it.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    const { container } = render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={[...pages, pages[0]!]} initialPage={1} />
      </MemoryRouter>,
    );

    // Page 2 is a landscape scan: wider than the half-viewport slot it would have
    // to share, so it takes a slot of its own.
    const landscape = screen.getByRole('img', { name: '第 2 页' });
    Object.defineProperty(landscape, 'naturalWidth', { configurable: true, value: 1400 });
    Object.defineProperty(landscape, 'naturalHeight', { configurable: true, value: 1000 });
    fireEvent.load(landscape);

    const frames = Array.from(container.querySelectorAll<HTMLElement>('.reader-frame'));
    const nextFrame = frames.find((frame) => frame.style.transform === 'translateX(100%)');
    expect(nextFrame?.querySelector('.reader-spread')).not.toBeNull();
    // One viewport to the right, pages 3 and 4 are already laid out as the pair
    // they will be the moment the swipe commits.
    expect(Array.from(nextFrame?.querySelectorAll('img') ?? []).map((image) => image.getAttribute('alt')))
      .toEqual(['第 3 页', '第 4 页']);
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

  it('swaps an enhanced page in without disturbing the zoom', async () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} />
      </MemoryRouter>,
    );
    const zoomed = () => container.querySelector('.reader-single') as HTMLElement;

    fireEvent.wheel(screen.getByRole('main', { name: '漫画阅读器' }), { deltaY: 120 });
    expect(zoomed().style.transform).toMatch(/scale\(0\.96/);

    // The enhanced rendition arrives after the plain page and takes its place in
    // the same slot. It used to be awaited inside the page load instead, so
    // nothing was on screen until inference finished — and whatever replaced the
    // page threw the zoom away with it.
    rerender(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} derivedPages={new Map([[0, 'blob:enhanced-0']])} />
      </MemoryRouter>,
    );
    // 换图要等新图解码完（先解码再换，见 lib/decodeImage），所以这里等一下而不是立刻断言。
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(zoomed().style.transform).toMatch(/scale\(0\.96/);
  });

  it('draws an enhanced page at the size the plain one measured', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} />
      </MemoryRouter>,
    );
    const measure = (element: HTMLElement, width: number, height: number) => {
      Object.defineProperty(element, 'naturalWidth', { configurable: true, value: width });
      Object.defineProperty(element, 'naturalHeight', { configurable: true, value: height });
      fireEvent.load(element);
    };

    const plain = screen.getByRole('img', { name: '第 1 页' });
    measure(plain, 700, 1000);
    expect(plain.style.getPropertyValue('--reader-page-max-width')).toBe('700px');
    expect(plain.style.getPropertyValue('--reader-page-max-height')).toBe('1000px');

    // The enhanced rendition is the same picture at twice the pixels. Sized by its
    // own natural size it would be drawn twice as large, so a zoomed reader watched
    // the magnification change the moment inference finished.
    rerender(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} derivedPages={new Map([[0, 'blob:enhanced-0']])} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    const enhanced = screen.getByRole('img', { name: '第 1 页' });
    measure(enhanced, 1400, 2000);
    expect(enhanced.style.getPropertyValue('--reader-page-max-width')).toBe('700px');
    expect(enhanced.style.getPropertyValue('--reader-page-max-height')).toBe('1000px');
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

  it('shows only available enhancement controls', async () => {
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
    expect(screen.queryByRole('button', { name: /去码/ })).not.toBeInTheDocument();
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

  it('preserves the decoded neighbouring image when a swipe lands', () => {
    const { container } = renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const incoming = container.querySelector('img[alt="第 2 页"]');
    expect(incoming).not.toBeNull();
    fireEvent.touchStart(reader, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchEnd(reader, { changedTouches: [{ clientX: 50, clientY: 100 }] });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBe(incoming);
  });

  it('ignores short swipes below the threshold', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    fireEvent.touchStart(reader, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(reader, { changedTouches: [{ clientX: 90, clientY: 100 }] });
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  });

  it('says the page is being processed instead of looking like nothing happened', async () => {
    // 去码/超分在本机跑一页要好几秒，两样一起近二十秒。这段时间屏幕上从前什么
    // 都没有——按下去像没反应，用户看到的就是「去码失效了」。胶囊只说在算。
    const view = render(
      <MemoryRouter>
        <ReaderScreen
          archiveId="a1"
          title="Test archive"
          pages={pages}
          derivedPages={new Map()}
          derivingPages={new Set([0])}
          derivingLabel="去码处理中…"
        />
      </MemoryRouter>,
    );
    const pill = await screen.findByRole('status');
    expect(pill).toHaveTextContent('去码处理中…');

    // 处理完了（产物换上去、或者失败退到原图）就不再压着那句话。
    view.rerender(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} derivedPages={new Map()} derivingPages={new Set()} derivingLabel="去码处理中…" />
      </MemoryRouter>,
    );
    expect(screen.queryByText('去码处理中…')).not.toBeInTheDocument();
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
