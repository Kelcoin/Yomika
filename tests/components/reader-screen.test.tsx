import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import { App } from '../../src/app/App';
import { ReaderScreen } from '../../src/components/ReaderScreen';
import { RetainedPage } from '../../src/app/RetainedPage';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { setImageDecoderForTests } from '../../src/lib/decodeImage';
import { resetOverlayBackGuardForTests } from '../../src/lib/overlayBackGuard';
import { COARSE_POINTER_QUERY } from '../../src/lib/horizontalScroller';

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
  const view = render(
    <MemoryRouter>
      <ReaderScreen archiveId="a1" title="Test archive" pages={pages} />
    </MemoryRouter>,
  );
  // jsdom does not decode the inline fixture. Model a successfully loaded image.
  markImagesReady(view.container);
  return view;
}

function markImagesReady(container: HTMLElement) {
  for (const image of container.querySelectorAll('img')) {
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 128 },
      naturalHeight: { configurable: true, value: 192 },
    });
  }
}

function pageIndicator() {
  return document.querySelector('.reader-page-indicator');
}

/** 造一张「竖着把屏幕占满」的页：底下没有缝，桌面那条规则本来会把它推去右下角。
 *  `naturalWidth` 分开传，好把「图片还没解码」这一态也造得出来。 */
function fillHeight(image: HTMLElement, naturalWidth: number) {
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: naturalWidth });
  Object.defineProperty(image, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 10, y: 0, top: 0, left: 10, right: 380, bottom: 844, width: 370, height: 844 }),
  });
}

/** 造一张「下面有缝」的页：底缝合 ≥44px 那一档，桌面规则会把它留在中间。 */
function fillHeightLetterbox(image: HTMLElement, naturalWidth: number) {
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: naturalWidth });
  Object.defineProperty(image, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 10, y: 0, top: 0, left: 10, right: 380, bottom: 600, width: 370, height: 600 }),
  });
}

/** 记下这一页被量了几次：还没解码的页不该被拿去量，`getBoundingClientRect` 一次都不该调。 */
function trackRects(image: HTMLElement) {
  let reads = 0;
  const measure = image.getBoundingClientRect.bind(image);
  Object.defineProperty(image, 'getBoundingClientRect', {
    configurable: true,
    value: () => { reads += 1; return measure(); },
  });
  return { count: () => reads };
}

/** 数一数整个文档在某个窗口里做了几次 `getBoundingClientRect`。在样式刚写过之后量是
 * 一次强制同步布局，一次拖动里多量几次就是「手指走了、画面还在后面追」。 */
function countRects() {
  const native = Element.prototype.getBoundingClientRect;
  let reads = 0;
  Element.prototype.getBoundingClientRect = function patched(this: Element) {
    reads += 1;
    return native.call(this);
  };
  return {
    count: () => reads,
    restore() { Element.prototype.getBoundingClientRect = native; },
  };
}

function stubHoverNone(initial = false) {
  const original = window.matchMedia;
  const listeners = new Map<string, Set<(event: { matches: boolean }) => void>>();
  let hoverNone = initial;
  // 真的 `matchMedia` 会解析逗号分隔的媒体查询列表（任一条命中就是真）。读者界面与横向
  // 导轨共用 `COARSE_POINTER_QUERY`（`(hover: none), (pointer: coarse)`），这个替身也得
  // 认那一条：只认 `(hover: none)` 会让「手指」在测试里永远是假的，于是被量到的是鼠标那
  // 一档，六条关于指示器落位的用例一起转红（真机上两者都对，是替身没跟上）。
  const answers = (query: string) => query === '(hover: none)' || query === COARSE_POINTER_QUERY;
  window.matchMedia = ((query: string) => ({
    get matches() { return answers(query) ? hoverNone : false; },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      const set = listeners.get(query) ?? new Set<(event: { matches: boolean }) => void>();
      set.add(listener);
      listeners.set(query, set);
    },
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.get(query)?.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    /** 换输入方式：改一下那两条查询的答案再发一次 change，就是接上鼠标 / 拔掉鼠标。 */
    setHoverNone(next: boolean) {
      hoverNone = next;
      for (const [query, set] of listeners) {
        if (!answers(query)) continue;
        for (const listener of set) listener({ matches: next });
      }
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

describe('reader screen', () => {
  it('keeps the plain page on screen until the processed one is decoded', async () => {
    // 超分/DLSSNR 算完是**同一页换 src**：浏览器在换的那一帧会先把旧图扔掉（旧图 → 空 → 新图），
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

  it('continues panning with the remaining finger after a pinch', async () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
    const x = window.innerWidth / 2;
    const y = window.innerHeight / 2;
    fireEvent.touchStart(reader, { touches: [{ clientX: x - 50, clientY: y }, { clientX: x + 50, clientY: y }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: x - 100, clientY: y }, { clientX: x + 100, clientY: y }] });
    fireEvent.touchEnd(reader, { touches: [{ clientX: x - 100, clientY: y }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: x, clientY: y + 40 }] });
    await act(async () => { await new Promise(requestAnimationFrame); });
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

  it('pans an enlarged page without paging and disables transform easing during drag', async () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
    // 落点写出来是因为双击现在会**锚在它上面**：锚点在画面正中时 pan 才是 0。
    // 锚点本身由下面那条用例钉住，这一条只关心「放大之后还能拖」。
    fireEvent.doubleClick(reader, { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 });
    fireEvent.mouseDown(reader, { button: 0, clientX: 300, clientY: 300 });
    fireEvent.mouseMove(reader, { buttons: 1, clientX: 400, clientY: 360 });
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(frame.style.transform).toBe(`scale(1.75) translate(${100 / 1.75}px, ${60 / 1.75}px)`);
    expect(frame.style.transition).toBe('none');
    fireEvent.mouseUp(reader, { button: 0, clientX: 400, clientY: 360 });
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  });

  // 用户报的：双击缩放和滚轮缩放不是同一种——滚轮以指针为锚点，双击却只翻倍率、
  // 再把 pan 归零，于是双击画面左侧的人物，那一块会被甩到屏幕正中。
  it('anchors the double-click zoom on the point it landed on, the way the wheel does', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
    // 画布盒子量不到时按视口兜底（`measureReaderRoot`），所以落点从视口中心算：
    // 中心往左 100px，对照放大后的实际屏幕坐标。
    const fromCentre = -100;
    fireEvent.doubleClick(reader, { clientX: window.innerWidth / 2 + fromCentre, clientY: window.innerHeight / 2 });
    expect(frame.style.transform).toContain('scale(1.75)');
    // 换一种说法验同一件事：缩放前落在指针下的内容点，缩放后仍然在指针下。
    // 屏上位置 = scale·(内容点 + pan)，两边都该等于锚点自己。
    const panX = Number(/translate\(([^p]+)px/.exec(frame.style.transform)?.[1]);
    expect(1.75 * (fromCentre + panX)).toBeCloseTo(fromCentre);
  });

  it('slides both bars away when the image starts zooming', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    const top = reader.querySelector('.reader-chrome-top');
    const bottom = reader.querySelector('.reader-toolbar');
    expect(top).toBeInTheDocument();
    expect(bottom).toBeInTheDocument();
    fireEvent.doubleClick(reader, { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 });
    expect(top).toHaveClass('is-leaving');
    expect(bottom).toHaveClass('is-leaving');
  });

  it('zooms about the midpoint of two fingers and springs undershoot back', async () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
    const y = window.innerHeight / 2;
    const x = window.innerWidth / 2 + 100;
    fireEvent.touchStart(reader, { touches: [{ clientX: x - 50, clientY: y }, { clientX: x + 50, clientY: y }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: x - 100, clientY: y }, { clientX: x + 100, clientY: y }] });
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(frame.style.transform).toBe('scale(2) translate(-50px, 0px)');
    fireEvent.touchMove(reader, { touches: [{ clientX: x - 20, clientY: y }, { clientX: x + 20, clientY: y }] });
    await act(async () => { await new Promise(requestAnimationFrame); });
    const undershoot = Number(frame.style.transform.match(/scale\(([^)]+)\)/)?.[1]);
    expect(undershoot).toBeGreaterThan(0.88);
    expect(undershoot).toBeLessThan(1);
    fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: x - 20, clientY: y }] });
    expect(frame.style.transform).toBe('scale(1) translate(0px, 0px)');
  });

  // 用户报的原话是「双指缩放将图片缩小到小于默认比例后松手图片不会复位到默认状态，
  // 然后过一会儿会瞬间复位」。触控板的双指捏合在 WebView 里就是 ctrl+wheel，它同时
  // 是**浏览器的页面缩放**手势：缩的是整页，而且不在阅读器的收势里。阅读器必须把它
  // 拦下来——分页档和条漫档都一样。
  it('keeps the browser page zoom out of the reader and springs the rubber scale back', async () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
    const y = window.innerHeight / 2;
    const x = window.innerWidth / 2 + 100;
    expect(fireEvent.wheel(reader, { ctrlKey: true, deltaY: 120, clientX: x, clientY: y })).toBe(false);
    fireEvent.touchStart(reader, { touches: [{ clientX: x - 50, clientY: y }, { clientX: x + 50, clientY: y }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: x - 20, clientY: y }, { clientX: x + 20, clientY: y }] });
    await act(async () => { await new Promise(requestAnimationFrame); });
    const undershoot = Number(frame.style.transform.match(/scale\(([^)]+)\)/)?.[1]);
    expect(undershoot).toBeGreaterThan(0.88);
    expect(undershoot).toBeLessThan(1);
    fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: x - 20, clientY: y }] });
    expect(frame.style.transform).toBe('scale(1) translate(0px, 0px)');
    // 收势不是硬跳：不在拖拽时那一层带 140ms 的过渡。
    expect(frame.style.transition).toContain('transform 140ms');
  });

  it('restores the frame when React still remembers the settled transform', async () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const frame = document.querySelector<HTMLElement>('.reader-frame .reader-spread, .reader-frame .reader-single')!;
    const box = reader.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    fireEvent.touchStart(reader, { touches: [{ clientX: x - 100, clientY: y }, { clientX: x + 100, clientY: y }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: x - 20, clientY: y }, { clientX: x + 20, clientY: y }] });
    await act(async () => { await new Promise(requestAnimationFrame); });
    const undershoot = Number(frame.style.transform.match(/scale\(([^)]+)\)/)?.[1]);
    expect(undershoot).toBeGreaterThan(0.88);
    expect(undershoot).toBeLessThan(1);
    // Separate the render that enables transitions from the direct DOM write.
    await act(async () => { fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: x - 20, clientY: y }] }); });
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(frame.style.transform).toBe('scale(1) translate(0px, 0px)');
  });

  it('keeps the browser page zoom out of the reader in continuous scroll too', async () => {
    const user = userEvent.setup();
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    await user.click(reader);
    const layoutButton = () => screen.getByRole('button', { name: /^阅读布局：/ });
    await user.click(layoutButton());
    await user.click(layoutButton());
    await user.click(layoutButton());
    expect(layoutButton()).toHaveAccessibleName('阅读布局：连续滚动，点击切换');
    // 条漫档里阅读器自己不管缩放，但浏览器的页面缩放同样不能放进来。
    expect(fireEvent.wheel(reader, { ctrlKey: true, deltaY: 120, clientX: 200, clientY: 300 })).toBe(false);
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

  // 唤出来的栏过一会儿自己走（4.5s）——加载态那条栏共用同一套，所以这条也钉住了
  // 「两条路径同一时长」。这条是回归护栏：它现在就该是绿的，重构之后必须还是绿的。
  it('hides the summoned bars on the auto-hide clock', () => {
    vi.useFakeTimers();
    const view = renderReader();
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      fireEvent.click(reader);
      expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument();
      // 4.5s 没人搭理：先是出场动画（0.26s），播完才把它摘掉。
      act(() => vi.advanceTimersByTime(4_500));
      act(() => vi.advanceTimersByTime(300));
      expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument();
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  // 用户报的 ⑧（2026-10-11）：「移动端下点击触发顶栏/底栏中的一侧时会导致同时触发两侧」。
  // 触屏没有悬停，`hoverChrome` 永远是 `undefined`，两条栏就只能跟着同一个 `visible`
  // 同亮同灭。现在按落点独立切换两侧，中部点击统一收起，鼠标路径不变。
  it('summons only the bar whose band the tap landed in', async () => {
    const media = stubHoverNone(true);
    try {
      renderReader();
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      const topBar = () => screen.queryByRole('button', { name: '返回上一页' });
      const bottomBar = () => screen.queryByRole('toolbar');

      fireEvent.click(reader, { clientY: 110 });
      expect(topBar()).toBeInTheDocument();
      expect(bottomBar()).not.toBeInTheDocument();

      // 另一条感应带可以继续唤出另一侧，不用先收起当前一侧。
      fireEvent.click(reader, { clientY: window.innerHeight - 110 });
      expect(bottomBar()).toBeInTheDocument();
      expect(topBar()).toBeInTheDocument();

      // 再点同一条只收起这一侧，中部点击才统一收起。
      fireEvent.click(reader, { clientY: window.innerHeight - 110 });
      await vi.waitFor(() => expect(bottomBar()).not.toBeInTheDocument());
      expect(topBar()).toBeInTheDocument();
      fireEvent.click(reader, { clientY: window.innerHeight / 2 });
      await vi.waitFor(() => expect(topBar()).not.toBeInTheDocument());
    } finally {
      media.restore();
    }
  });

  // 鼠标那条路径不动：桌面靠悬停选边，点一下两条都出来（旧行为，有上面的既有用例钉着）。
  it('still flips both bars together for a mouse click', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader, { clientY: 110 });
    expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument();
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
  });

  // 钉住的那一侧比 `visible` 强势（`topChromeVisible = hoverChrome === 'top'`），自动
  // 隐藏时不清掉它就再也摘不下来。
  it('hides the pinned bar on the auto-hide clock too', () => {
    vi.useFakeTimers();
    const media = stubHoverNone(true);
    const view = renderReader();
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      fireEvent.click(reader, { clientY: 110 });
      expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(4_500));
      act(() => vi.advanceTimersByTime(300));
      expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument();
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    } finally {
      view.unmount();
      media.restore();
      vi.useRealTimers();
    }
  });

  // 反面：划页是手势，不是又一次「点」——翻页不该把另一条栏顺手带出来。
  it('keeps the pinned bar pinned while a swipe turns the page', async () => {
    const media = stubHoverNone(true);
    try {
      renderReader();
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      fireEvent.click(reader, { clientY: 110 });
      expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument();

      fireEvent.touchStart(reader, { touches: [{ clientX: 200, clientY: 100 }] });
      fireEvent.touchEnd(reader, { changedTouches: [{ clientX: 50, clientY: 100 }] });

      // 等过退场那一档（260ms）再看：只靠「还在 DOM 里」会被 `useDelayedUnmount` 骗过——
      // 意见被清掉的那棵树里，顶栏照样多留 260ms。
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 320); }); });
      expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument();
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    } finally {
      media.restore();
    }
  });

  // 用户报的 ④：两条顶栏的标题都是 `flex: 1`，吃的是前导按钮**之后**的剩余宽度，
  // 所以整条栏看起来是偏左的。这里量不出布局（jsdom 没有布局，也没开 `css: true`），
  // 所以按样式表本身断言。
  //
  // 2026-10-11（user report：「阅读模式顶栏的标题会和右侧按钮重叠」）：原来两条栏都写成
  // 「两侧 minmax(一颗图标, 1fr) + 标题 minmax(0, auto)」，想靠两条等宽的 1fr 让标题
  // 相对整条栏居中。Grid 的次序不是这样：§12.6.3 先把剩余空间喂给 `auto` 轨道，`fr`
  // 轨道要等 §12.6.4 才轮到，于是标题把中间那条吃满、右侧轨道永远停在一颗图标的 44px
  // 上，尾部那排按钮（手机上两颗＝92px）就从自己那一格里向左溢出、压在标题上——真机
  // 390px 实测压住 44px，尾部四颗控件时 156px（工装与读数在 debug_outputs/reader-topbar）。
  // 阅读态那条栏因此改成「两侧按内容定宽、标题吃掉剩下的全部」：尾部挂几颗按钮都不会
  // 再压到标题，代价是两侧不等宽时标题在**剩余空间**里居中，不再相对整条栏居中。
  // 错误态那条栏两侧各只有一颗（返回 / 空），等宽，所以照旧——整条栏居中在那里仍成立。
  it('keeps both ends of the reader bar reachable and gives the title what is left', () => {
    const css = readFileSync(resolve(__dirname, '../..', 'src/styles/reader.css'), 'utf8').replace(/\r\n/g, '\n');
    const body = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
      if (!match) throw new Error(`reader.css 里找不到规则 ${selector}`);
      return match[1];
    };
    expect(body('.reader-chrome-top')).toContain('display: grid');
    // 只有标题那一条轨道是 1fr，两侧按内容定宽（再挂第二条 1fr 就会把上面那个
    // 先后次序请回来，重叠跟着回来）。
    expect(body('.reader-chrome-top')).toContain('grid-template-columns: auto minmax(0, 1fr) auto;');
    expect(body('.reader-error-bar')).toContain('display: grid');
    expect(body('.reader-error-bar')).toContain('grid-template-columns: minmax(var(--icon-button-size), 1fr) minmax(0, auto) minmax(var(--icon-button-size), 1fr);');
    for (const title of ['.reader-chrome-top strong', '.reader-error-bar strong']) {
      expect(body(title)).toContain('grid-column: 2');
      expect(body(title)).toContain('text-align: center');
      // 窄屏：中间那条轨道可以被压到 0，标题自己也得能收成省略号。
      expect(body(title)).toContain('min-width: 0');
      expect(body(title)).toContain('max-width: 100%');
      expect(body(title)).toContain('text-overflow: ellipsis');
    }
  });

  it('puts the title and the trailing controls in their own grid cells', () => {
    renderReader();
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    const bar = document.querySelector('.reader-chrome-top');
    expect(bar).not.toBeNull();
    // 标题必须是这条栏的**直接**子项，才落在中间那条轨道上；包一层就不再是「相对整条栏」。
    const title = bar?.querySelector('strong');
    expect(title?.textContent).toBe('Test archive');
    expect(title?.parentElement).toBe(bar);
    // 右侧的几颗按钮同处第三格，不会各自去挤中间那条轨道。
    const actions = bar?.querySelector('.reader-chrome-actions');
    expect(actions).not.toBeNull();
    expect(actions?.contains(screen.getByRole('button', { name: '缩略面板' }))).toBe(true);
    expect(actions?.contains(screen.getByRole('link', { name: '阅读设置' }))).toBe(true);
  });

  it('clears a pending swipe when a second finger joins', () => {    vi.useFakeTimers();
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

  it('routes desktop drags from a bottom control through the page swipe', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    // 底栏那三颗在底端感应带里，鼠标挪过去就把底栏叫出来（点一下只会亮起点在的那一侧）。
    fireEvent.mouseMove(reader, { buttons: 0, clientY: window.innerHeight - 110 });
    const button = screen.getByRole('button', { name: /阅读布局/ });
    fireEvent.mouseDown(button, { button: 0, clientX: 500, clientY: 700 });
    fireEvent.mouseMove(reader, { buttons: 1, clientX: 100, clientY: 700 });
    fireEvent.mouseUp(reader, { button: 0, clientX: 100, clientY: 700 });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
  });

  it('keeps toolbar Space, composition and modified arrows out of canvas navigation', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.mouseMove(reader, { buttons: 0, clientY: window.innerHeight - 110 });
    fireEvent.keyDown(screen.getByRole('button', { name: /阅读布局/ }), { key: ' ' });
    fireEvent.keyDown(reader, { key: 'ArrowRight', isComposing: true });
    fireEvent.keyDown(reader, { key: 'ArrowRight', ctrlKey: true });
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
  });

  it('does not capture a pointer pressed on empty reader chrome', async () => {
    await act(async () => { renderReader(); });
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.mouseMove(reader, { buttons: 0, clientY: window.innerHeight - 110 });
    const capture = vi.fn();
    reader.setPointerCapture = capture;
    // jsdom has no native PointerEvent constructor; preserve its pointer fields
    // explicitly so this exercises the mouse branch rather than vacuously passing.
    const pointerDown = (target: Element, pointerId: number) => {
      const event = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
      Object.defineProperties(event, { pointerType: { value: 'mouse' }, pointerId: { value: pointerId } });
      fireEvent(target, event);
    };
    pointerDown(screen.getByRole('toolbar', { name: '阅读控制' }), 1);
    expect(capture).not.toHaveBeenCalled();
    pointerDown(reader, 2);
    expect(capture).toHaveBeenCalledWith(2);
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

  it('parks the page indicator in the corner when a mouse has the room, and only then', async () => {
    // 量底缝那一段的两次纠正（rAF + 240ms）在 jsdom 里不保证跑得到；换上指针类型会
    // 让这个 effect 重跑，而 effect 里的 ResizeObserver 在 jsdom 里是**同步**回调的
    // （见 tests/setup.ts），所以这一步量得确定。
    const media = stubHoverNone(true);
    try {
      renderReader();
      fillHeight(screen.getByRole('img', { name: '第 1 页' }), 700);
      expect(pageIndicator()?.getAttribute('data-placement')).toBe('bottom');

      await act(async () => { media.setHoverNone(false); });
      expect(pageIndicator()?.getAttribute('data-placement')).toBe('corner');
    } finally {
      media.restore();
    }
  });

  it('keeps the page indicator centred once the pointer is a finger, whatever the page measures', async () => {
    // 竖着把屏幕占满的页在桌面上会把胶囊推进右边缝里；手机上那里正是手指待的地方，
    // 而半格宽的画面本来就没有「缝」。用户报的就是这一条：移动端应该居中。
    const media = stubHoverNone(true);
    try {
      renderReader();
      fillHeight(screen.getByRole('img', { name: '第 1 页' }), 700);

      // 鼠标在：底缝算出来是 0，这一档确实去了右下角——量是量得准的。
      await act(async () => { media.setHoverNone(false); });
      expect(pageIndicator()?.getAttribute('data-placement')).toBe('corner');

      // 同一台设备换上手指：底缝还是 0，但这一格不再给右下角。
      await act(async () => { media.setHoverNone(true); });
      expect(pageIndicator()?.getAttribute('data-placement')).toBe('bottom');
    } finally {
      media.restore();
    }
  });

  it('does not let a page that has not decoded yet push the page indicator into the corner', async () => {
    // 还没解码完的那一页量到的是盒子（100% × 100dvh），不是画出来的那一块：底缝算出来
    // 永远是 0，胶囊先跳右下角、等图片 load 完再跳回来——翻页时那一下闪动就是它。
    // 两次纠正（rAF + 240ms）在 jsdom 里不保证哪一次跑得到，所以每一步都真等到它们过去；
    // 指针类型是 effect 的依赖，换一次就是一次确定的重新量。
    const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 300); }); });
    const media = stubHoverNone(false);
    try {
      renderReader();
      const page = screen.getByRole('img', { name: '第 1 页' });

      // ① 占满屏幕的、已经解码的页：桌面上这一档确实去右下角——先证明量是准的。
      fillHeight(page, 700);
      await settle();
      expect(pageIndicator()?.getAttribute('data-placement')).toBe('corner');

      // ② 下面有缝的、已经解码的页：换指针类型这一次确实重新量过，量到的也是新尺寸。
      //    下一条断言靠的就是这一点，不然它只是「什么都没量」的同义词。
      fillHeightLetterbox(page, 700);
      const decoded = trackRects(page);
      await act(async () => { media.setHoverNone(true); });
      await settle();
      expect(decoded.count()).toBeGreaterThan(0);
      expect(pageIndicator()?.getAttribute('data-placement')).toBe('bottom');
      await act(async () => { media.setHoverNone(false); });
      await settle();

      // ③ 页面还没解码：空盒子不该被拿去量，也不该把胶囊推走。
      fillHeight(page, 0);
      const undecoded = trackRects(page);
      await act(async () => { media.setHoverNone(true); });
      await settle();
      expect(undecoded.count()).toBe(0);
      expect(pageIndicator()?.getAttribute('data-placement')).toBe('bottom');
    } finally {
      media.restore();
    }
  });

  it('only measures the letterbox a second time when something is actually moving', async () => {
    // 翻一页会重跑这段测量。第二趟（240ms 后）是给「胶囊正在两档之间滑、图片正在缩放
    // 回弹」的第一帧过渡值擦屁股的；结论没变的那一轮再量一次只是白读一次同步布局——
    // 用户报的「快速连续翻页卡顿」里每一轮都有它。判据就落在「这一轮量了几次」上。
    const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 300); }); });
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    for (const image of document.querySelectorAll<HTMLElement>('.reader-frame img')) fillHeightLetterbox(image, 700);
    await settle();
    expect(pageIndicator()?.getAttribute('data-placement')).toBe('corner');

    const reads = trackRects(pageIndicator() as HTMLElement);
    const before = reads.count();
    await act(async () => { fireEvent.keyDown(reader, { key: 'ArrowRight' }); });
    const afterCommit = reads.count();
    // 翻页后新露出来的那几页也得是「已经解码、底下有缝」的：不然这一轮量不到东西，
    // 下面第二条断言就成了「什么都没测」的同义词。
    for (const image of document.querySelectorAll<HTMLElement>('.reader-frame img')) fillHeightLetterbox(image, 700);
    await settle();
    const afterSettle = reads.count();

    expect(afterCommit - before).toBeGreaterThan(0);
    expect(afterSettle - afterCommit).toBe(1);
  });

  it('re-measures after the pill has slid into its new placement, not only in the first frame', async () => {
    // 结论变了的那一轮（这里：从「手指在，居中」换成「鼠标在，去右下角」）第二趟测量是
    // 承重的：第一帧读到的还是胶囊在滑动途中的矩形。这一条把「滑到位」交给测试自己控制，
    // 不靠墙钟——同步那几趟与下一帧那一趟读的都是滑动中，之后才只有 240ms 那一趟读得到。
    const wait = (ms: number) => act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
    const media = stubHoverNone(true);
    try {
      renderReader();
      fillHeight(screen.getByRole('img', { name: '第 1 页' }), 700);
      await wait(1900); // 「翻页闪一下」的窗口过去，重叠那一档才显示得出来
      expect(pageIndicator()?.getAttribute('data-placement')).toBe('bottom');

      let slid = false;
      const withOverlap = { x: 300, y: 10, top: 10, left: 300, right: 370, bottom: 40, width: 70, height: 30 };
      const sliding = { x: 400, y: 10, top: 10, left: 400, right: 470, bottom: 40, width: 70, height: 30 };
      Object.defineProperty(pageIndicator() as HTMLElement, 'getBoundingClientRect', {
        configurable: true,
        value: () => (slid ? withOverlap : sliding),
      });

      await act(async () => { media.setHoverNone(false); });
      await wait(120); // 同步那几趟与下一帧那一趟都过去了：现在胶囊还在路上
      expect(pageIndicator()?.getAttribute('data-placement')).toBe('corner');

      slid = true; // 胶囊滑到位了，压在画面上——只有第二趟测量才会看到这一幕
      await wait(300);
      expect(pageIndicator()?.getAttribute('data-placement')).toBe('corner');
      expect(pageIndicator()?.getAttribute('data-visible')).toBe('false');
    } finally {
      media.restore();
    }
  });

  it('supports keyboard paging without crossing bounds', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    fireEvent.keyDown(reader, { key: 'PageDown' });
    expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();
    // 末页再往下一页翻那一下已经不属于「翻页」了——它退出阅读模式，由下面那条用例
    // 单钉（见 'leaves the reader when a next-page turn happens on the last page'）。
    fireEvent.keyDown(reader, { key: 'ArrowLeft' });
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
  });

  // 用户报 13（2026-10-18）：「在阅读模式时，在最后一页继续往下一页方向翻页无法退出阅读
  // 模式。」原来 `advanceReader` 被 `clampPage` 夹在最后一页上，那一翻什么也没发生。现在
  // 它接到顶栏返回键同一条路径（`goBack`）——所以判据断言的是「路由真的回到了来处」，
  // 而不是某个内部标志。这条用例自己给路由表：没有路由可去的话，「退出了」和「还停在
  // 原地」在断言层面长得一模一样。
  it('leaves the reader when a next-page turn happens on the last page', () => {
    render(
      <MemoryRouter initialEntries={['/library', '/reader']} initialIndex={1}>
        <Routes>
          <Route path="/library" element={<p>library list</p>} />
          <Route path="/reader" element={<ReaderScreen archiveId="a1" title="Test archive" pages={pages} />} />
        </Routes>
      </MemoryRouter>,
    );
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();

    // 缺陷形态：这一下被夹住，页还是第 3 页，阅读器还在。
    fireEvent.keyDown(reader, { key: 'ArrowRight' });

    expect(screen.queryByRole('main', { name: '漫画阅读器' })).not.toBeInTheDocument();
    expect(screen.getByText('library list')).toBeInTheDocument();
  });

  // 同一条路的手势入口：在末页往下一页方向甩一下也该退出。这条路走 `finishDrag`，
  // 它原来只在「页号真的变了」时才提交，末页那一甩连 `move()` 都到不了，手指划到头
  // 只是弹回去——同样是报告 13 说的那一下。
  it.each(['ltr', 'rtl'] as const)('leaves the reader when a %s swipe past the last page is released', (direction) => {
    render(
      <MemoryRouter initialEntries={['/library', '/reader']} initialIndex={1}>
        <Routes>
          <Route path="/library" element={<p>library list</p>} />
          <Route path="/reader" element={<ReaderScreen archiveId="a1" title="Test archive" pages={pages} direction={direction} />} />
        </Routes>
      </MemoryRouter>,
    );
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const turnForward = () => {
      fireEvent.touchStart(reader, { touches: [{ clientX: direction === 'ltr' ? 200 : 50, clientY: 100 }] });
      fireEvent.touchEnd(reader, { changedTouches: [{ clientX: direction === 'ltr' ? 50 : 200, clientY: 100 }] });
    };

    turnForward();
    turnForward();
    expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();

    // A short final-page flick bounces back. A longer deliberate pull exits.
    fireEvent.touchStart(reader, { touches: [{ clientX: direction === 'ltr' ? 200 : 135, clientY: 100 }] });
    fireEvent.touchEnd(reader, { changedTouches: [{ clientX: direction === 'ltr' ? 135 : 200, clientY: 100 }] });
    expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();
    fireEvent.touchStart(reader, { touches: [{ clientX: direction === 'ltr' ? 360 : 40, clientY: 100 }] });
    fireEvent.touchEnd(reader, { changedTouches: [{ clientX: direction === 'ltr' ? 40 : 360, clientY: 100 }] });

    expect(screen.queryByRole('main', { name: '漫画阅读器' })).not.toBeInTheDocument();
    expect(screen.getByText('library list')).toBeInTheDocument();
  });

  it.each(['ltr', 'rtl'] as const)('shows the %s final-page exit cue and exits on release without waiting for spring-back', (direction) => {
    const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1; });
    try {
      render(<MemoryRouter initialEntries={['/library', '/reader']} initialIndex={1}>
        <Routes><Route path="/library" element={<p>library list</p>} />
          <Route path="/reader" element={<ReaderScreen archiveId="exit-cue" title="Final" pages={pages} layout="single" initialPage={2} direction={direction} />} />
        </Routes>
      </MemoryRouter>);
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      const startX = direction === 'ltr' ? 360 : 40;
      const endX = direction === 'ltr' ? 40 : 360;
      fireEvent.touchStart(reader, { touches: [{ clientX: startX, clientY: 300 }] });
      fireEvent.touchMove(reader, { touches: [{ clientX: endX, clientY: 300 }] });
      const hint = document.querySelector('.reader-exit-hint');
      expect(hint).toHaveAttribute('data-visible', 'true');
      expect(hint).toHaveAttribute('data-ready', 'true');
      expect(hint).toHaveAttribute('data-side', direction === 'ltr' ? 'right' : 'left');
      expect(hint).toHaveAttribute('aria-label', '松手退出阅读');
      expect(hint?.textContent).toBe('');
      expect((hint as HTMLElement).style.getPropertyValue('--reader-exit-progress')).toBe('1');
      const track = reader.querySelector('.reader-track') as HTMLElement;
      const draggedTransform = track.style.transform;
      fireEvent.touchEnd(reader, { changedTouches: [{ clientX: endX, clientY: 300 }] });
      expect(screen.getByText('library list')).toBeInTheDocument();
      expect(animate).not.toHaveBeenCalled();
      expect(track.style.transform).toBe(draggedTransform);
    } finally {
      vi.restoreAllMocks();
      if (original) Object.defineProperty(HTMLElement.prototype, 'animate', original);
      else delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });

  it('hides the final-page exit cue when the gesture is cancelled', () => {
    vi.useFakeTimers();
    const view = render(<MemoryRouter><ReaderScreen archiveId="cancel-exit" title="Final" pages={pages} layout="single" initialPage={2} /></MemoryRouter>);
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      fireEvent.touchStart(reader, { touches: [{ clientX: 400, clientY: 300 }] });
      fireEvent.touchMove(reader, { touches: [{ clientX: 330, clientY: 300 }] });
      act(() => vi.advanceTimersByTime(32));
      const hint = document.querySelector<HTMLElement>('.reader-exit-hint')!;
      const progress = () => Number(hint.style.getPropertyValue('--reader-exit-progress'));
      expect(hint.querySelector('.reader-exit-hint-fill')).toBeInTheDocument();
      expect(progress()).toBeGreaterThan(0);
      expect(progress()).toBeLessThan(1);
      const previous = progress();
      fireEvent.touchMove(reader, { touches: [{ clientX: 360, clientY: 300 }] });
      act(() => vi.advanceTimersByTime(32));
      expect(progress()).toBeGreaterThan(0);
      expect(progress()).toBeLessThan(previous);
      expect(hint).toHaveAttribute('data-visible', 'true');
      fireEvent.touchCancel(reader);
      expect(hint).toHaveAttribute('data-visible', 'false');
      expect(hint).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  // 反向的那一头只是停住，不是合上书：报告 13 说的是「往下一页方向」。
  it('exits past the final page in right-to-left reading', () => {
    render(<MemoryRouter initialEntries={['/library', '/reader']} initialIndex={1}>
      <Routes><Route path="/library" element={<p>library list</p>} />
        <Route path="/reader" element={<ReaderScreen archiveId="rtl" title="RTL" pages={pages} direction="rtl" layout="single" initialPage={2} />} />
      </Routes>
    </MemoryRouter>);
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'ArrowLeft' });
    expect(screen.getByText('library list')).toBeInTheDocument();
  });

  it('stays put when paging backwards from the first page', () => {
    render(
      <MemoryRouter initialEntries={['/library', '/reader']} initialIndex={1}>
        <Routes>
          <Route path="/library" element={<p>library list</p>} />
          <Route path="/reader" element={<ReaderScreen archiveId="a1" title="Test archive" pages={pages} />} />
        </Routes>
      </MemoryRouter>,
    );
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    fireEvent.keyDown(reader, { key: 'ArrowLeft' });
    fireEvent.keyDown(reader, { key: 'ArrowLeft' });

    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: '漫画阅读器' })).toBeInTheDocument();
    expect(screen.queryByText('library list')).not.toBeInTheDocument();
  });

  // 连续滚动档（条漫）滚到底不能被当成「翻到下一页」把书合上。这一档的纵向手势由滚动
  // 拥有——`onWheel` 在 webtoon 直接 return，根本走不到 `move`——用户在页面底部的继续
  // 下拉只该停在最后一页；键盘/按钮在这一档同理只是停住。
  it('does not close continuous mode when it runs past the last page', () => {
    render(
      <MemoryRouter initialEntries={['/library', '/reader']} initialIndex={1}>
        <Routes>
          <Route path="/library" element={<p>library list</p>} />
          <Route path="/reader" element={<ReaderScreen archiveId="a1" title="Test archive" pages={pages} layout="webtoon" />} />
        </Routes>
      </MemoryRouter>,
    );
    const reader = screen.getByRole('main', { name: '漫画阅读器' });

    for (let step = 0; step < 4; step += 1) fireEvent.keyDown(reader, { key: 'ArrowRight' });

    expect(screen.getByRole('main', { name: '漫画阅读器' })).toBeInTheDocument();
    expect(screen.queryByText('library list')).not.toBeInTheDocument();
  });

  // 反面：上头那条退出判据不能把自动翻页也带进去。读到末页它该停下来等读者——人在末页
  // 发呆时书自己合上，比「翻不动」还糟。`move` 的第二参数就是为这一档留的。
  it('does not close the reader when auto-play reaches the last page', () => {
    vi.useFakeTimers();
    const view = render(
      <MemoryRouter initialEntries={['/library', '/reader']} initialIndex={1}>
        <Routes>
          <Route path="/library" element={<p>library list</p>} />
          <Route path="/reader" element={<ReaderScreen archiveId="a1" title="Test archive" pages={pages} />} />
        </Routes>
      </MemoryRouter>,
    );
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      fireEvent.keyDown(reader, { key: 'ArrowRight' });
      fireEvent.keyDown(reader, { key: 'ArrowRight' });
      expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();

      fireEvent.click(reader);
      fireEvent.click(screen.getByRole('button', { name: '自动翻页' }));
      act(() => vi.advanceTimersByTime(5_000));

      expect(screen.getByRole('main', { name: '漫画阅读器' })).toBeInTheDocument();
      expect(screen.queryByText('library list')).not.toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
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

  it('uses the mouse wheel for zoom on paged reading canvas', async () => {
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
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(zoomed().getAttribute('style')).toMatch(/scale\(0\.96/);
    expect(screen.getByRole('img', { name: '第 1 页' }).getAttribute('style')).toBeNull();
    fireEvent.wheel(reader, { deltaY: -120 });
    await act(async () => { await new Promise(requestAnimationFrame); });
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
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageUp' });

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

  it('turns once when swiping from a bottom action and suppresses its compatibility click', async () => {
    const toggle = vi.fn();
    render(<MemoryRouter><ReaderScreen archiveId="a1" title="Test archive" pages={pages} layout="single"
      upscale={{ configured: true, active: false, toggle }} /></MemoryRouter>);
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    const action = screen.getByRole('button', { name: '开启超分' });
    const touch = (clientX: number) => ({ clientX, clientY: 700 });
    // A release has no swipe ownership until a horizontal move was observed.
    fireEvent.touchStart(action, { touches: [touch(490)] });
    fireEvent.touchEnd(action, { touches: [], changedTouches: [touch(160)] });
    fireEvent.click(action, { detail: 1 });
    expect(toggle).not.toHaveBeenCalled();
    expect(reader.querySelector('.reader-toolbar-counter')).toHaveTextContent('1 / 3');
    fireEvent.touchStart(action, { touches: [touch(490)] });
    fireEvent.touchMove(action, { touches: [touch(300)] });
    fireEvent.touchEnd(action, { touches: [], changedTouches: [touch(160)] });
    fireEvent.click(action, { detail: 1 });
    expect(toggle).not.toHaveBeenCalled();
    await waitFor(() => expect(reader.querySelector('.reader-toolbar-counter')).toHaveTextContent('2 / 3'));
    fireEvent.touchStart(action, { touches: [touch(490)] });
    fireEvent.touchEnd(action, { touches: [], changedTouches: [touch(490)] });
    fireEvent.click(action, { detail: 1 });
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('opens the virtual thumbnail grid around the current page and shows its scrollbar while scrolling', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(12_000);
    const original = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const style = original(element);
      if (element.classList.contains('reader-overview-thumbnails')) style.overflowY = 'auto';
      return style;
    });
    try {
      render(<MemoryRouter><ReaderScreen archiveId="a1" title="Long archive" pages={Array.from({ length: 300 }, (_, index) => `page-${index}`)} initialPage={157} /></MemoryRouter>);
      fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
      fireEvent.click(screen.getByRole('button', { name: '缩略面板' }));
      const tile = screen.getByRole('button', { name: '跳转到第 158 页' });
      expect(tile).toHaveAttribute('aria-current', 'true');
      expect(tile).toHaveClass('archive-page-thumbnail');
      expect(tile.querySelector('.archive-page-thumbnail-number')).toHaveTextContent('158');
      expect(screen.queryByRole('button', { name: '跳转到第 1 页' })).not.toBeInTheDocument();
      const grid = tile.parentElement!;
      expect(grid.scrollTop).toBeGreaterThan(1000);
      fireEvent.scroll(grid);
      expect(screen.getByRole('scrollbar', { name: '缩略图滚动位置' })).toHaveAttribute('data-scrolling', 'true');
    } finally {
      width.mockRestore();
      height.mockRestore();
      scrollHeight.mockRestore();
      styles.mockRestore();
    }
  });

  it('closes the thumbnail panel on the system back gesture before leaving the reader', async () => {
    const user = userEvent.setup();
    resetOverlayBackGuardForTests();
    // jsdom 的历史接着上一批用例往下长：把当前这一格的层号抹干净，退回来才是「页面」那一格。
    window.history.replaceState({}, '');
    renderReader();

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '缩略面板' }));
    expect(screen.getByRole('button', { name: '跳转到第 3 页' })).toBeInTheDocument();

    // 手机返回手势落到这里就是一次 popstate（Tauri 把返回交给 webview 的历史）。
    // 守卫条目是 `pushState` 压的，设备上按返回就是浏览器退一格：这里也真退一格——退几层
    // 看的是**落地那一格的层号**，同一次手势还可能被补发成两个事件。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => { window.history.back(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(screen.queryByRole('button', { name: '跳转到第 3 页' })).not.toBeInTheDocument();
    expect(screen.getByRole('main', { name: '漫画阅读器' })).toBeInTheDocument();
    resetOverlayBackGuardForTests();
  });

  it('loads the latest thumbnail window after a rapid jump even when an earlier request fails', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(330);
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    const original = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const style = original(element);
      if (element.classList.contains('reader-overview-thumbnails')) style.overflowY = 'auto';
      return style;
    });
    const queued: Array<() => void> = [];
    const loadPageThumbnail = vi.fn((index: number) => index < 20
      ? new Promise<string>((resolve, reject) => queued.push(() => index % 2 ? reject(new Error('unavailable')) : resolve(`thumb-${index}`)))
      : Promise.resolve(`thumb-${index}`));
    try {
      const { container } = render(<MemoryRouter><ReaderScreen archiveId="a1" title="Long archive"
        pages={Array.from({ length: 300 }, () => pages[0]!)} loadPageThumbnail={loadPageThumbnail} /></MemoryRouter>);
      fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
      fireEvent.click(screen.getByRole('button', { name: '缩略面板' }));
      await waitFor(() => expect(queued).toHaveLength(4));
      const grid = container.querySelector<HTMLElement>('.reader-overview-thumbnails')!;
      grid.scrollTop = 9000;
      fireEvent.scroll(grid);
      await waitFor(() => expect(screen.queryByRole('button', { name: '跳转到第 1 页' })).not.toBeInTheDocument());
      expect(loadPageThumbnail).toHaveBeenCalledTimes(4);
      await act(async () => { queued.forEach((complete) => complete()); });
      const visible = [...grid.querySelectorAll<HTMLButtonElement>('button')];
      expect(visible.length).toBeGreaterThan(3);
      await waitFor(() => expect(visible.every((tile) => tile.querySelector('img')?.getAttribute('src')?.startsWith('thumb-'))).toBe(true));
      expect(loadPageThumbnail.mock.calls.filter(([index]) => index < 20)).toHaveLength(4);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '关闭概览' })); });
    } finally {
      width.mockRestore();
      height.mockRestore();
      styles.mockRestore();
    }
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

    await vi.waitFor(() => expect(loadPageThumbnail.mock.calls.map(([index]) => index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]));
    // Only the prefetch window may be fetched at full size, never the whole archive.
    expect(loadPage.mock.calls.map(([index]) => index)).toEqual([1]);
  });

  it('auto-hides chrome while the overview remains open', () => {
    vi.useFakeTimers();
    try {
      render(<MemoryRouter><ReaderScreen archiveId="a1" title="Test archive" pages={pages} /></MemoryRouter>);
      fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
      fireEvent.click(screen.getByRole('button', { name: '缩略面板' }));
      act(() => vi.advanceTimersByTime(5_000));
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole('complementary', { name: '档案概览' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('resets automatic paging when leaving a retained reader', () => {
    const content = <MemoryRouter><ReaderScreen archiveId="a1" title="Test archive" pages={pages} /></MemoryRouter>;
    const view = render(<RetainedPage active>{content}</RetainedPage>);
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '自动翻页' }));
    expect(screen.getByRole('button', { name: '停止自动翻页' })).toBeInTheDocument();
    view.rerender(<RetainedPage active={false}>{content}</RetainedPage>);
    view.rerender(<RetainedPage active>{content}</RetainedPage>);
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(screen.queryByRole('button', { name: '停止自动翻页' })).not.toBeInTheDocument();
  });

  it('closes the thumbnail panel and stops its queue when the reader becomes inactive', async () => {
    const finish: Array<(url: string) => void> = [];
    const loadPageThumbnail = vi.fn(() => new Promise<string>((resolve) => { finish.push(resolve); }));
    const content = <MemoryRouter><ReaderScreen archiveId="a1" title="Test archive" pages={Array.from({ length: 12 }, () => pages[0]!)}
      loadPageThumbnail={loadPageThumbnail} /></MemoryRouter>;
    const view = render(<RetainedPage active>{content}</RetainedPage>);
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '缩略面板' }));
    await waitFor(() => expect(loadPageThumbnail).toHaveBeenCalledTimes(4));
    view.rerender(<RetainedPage active={false}>{content}</RetainedPage>);
    expect(document.querySelector('.reader-overview-backdrop')).not.toBeInTheDocument();
    await act(async () => { finish.forEach((complete) => complete('old-thumbnail')); });
    expect(loadPageThumbnail).toHaveBeenCalledTimes(4);
    view.rerender(<RetainedPage active>{content}</RetainedPage>);
    expect(document.querySelector('.reader-overview-backdrop')).not.toBeInTheDocument();
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

  it('follows a drag from the box it took at the press, not from a fresh measurement per move', () => {
    vi.useFakeTimers();
    const view = renderReader();
    // Exclude initial loaded-image/page-indicator measurements from the gesture.
    act(() => { vi.advanceTimersByTime(300); });
    const rects = countRects();
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      const track = reader.querySelector('.reader-track') as HTMLDivElement;
      fireEvent.mouseDown(reader, { button: 0, clientX: 600, clientY: 200 });
      // 按下那一下量一次是对的（这一趟拖动要用多宽是那一刻的事实）。错的是一路跟着量：
      // 每次 `mousemove` 都量，就是在每次都在样式刚写过之后强制同步布局一次。
      const atPress = rects.count();
      for (let step = 1; step <= 12; step += 1) {
        fireEvent.mouseMove(reader, { buttons: 1, clientX: 600 - step * 20, clientY: 200 });
      }
      act(() => { vi.advanceTimersByTime(32); });
      expect(rects.count()).toBe(atPress);
      expect(track.style.transform).toBe('translate3d(-240px,0,0)');
    } finally {
      rects.restore();
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('coalesces a burst of pointer moves into one transform write per frame', () => {
    vi.useFakeTimers();
    const view = renderReader();
    let restoreFrame = () => {};
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      fireEvent.mouseDown(reader, { button: 0, clientX: 640, clientY: 200 });
      const scheduled = vi.spyOn(window, 'requestAnimationFrame');
      restoreFrame = () => scheduled.mockRestore();
      // 一只 1000Hz 的鼠标在两帧之间能塞进十几个 `mousemove`。每一次都排一帧的话，
      // 这一帧里就要往同一个 transform 上写十几遍——写一次和写十六次的画面一样，代价不一样。
      for (let step = 1; step <= 16; step += 1) {
        fireEvent.mouseMove(reader, { buttons: 1, clientX: 640 - step * 10, clientY: 200 });
      }
      expect(scheduled).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(32); });
      // 这一帧的那一次写要落到最后一个位置，而不是中间某一个。
      const track = reader.querySelector('.reader-track') as HTMLDivElement;
      expect(track.style.transform).toBe('translate3d(-160px,0,0)');
    } finally {
      view.unmount();
      restoreFrame();
      vi.useRealTimers();
    }
  });

  it.each(['ltr', 'rtl'] as const)('keeps %s book-end drags bounded and springs back only at the first page', async (direction) => {
    vi.useFakeTimers();
    const view = render(<MemoryRouter initialEntries={['/library', '/reader']} initialIndex={1}>
      <Routes><Route path="/library" element={<p>returned to library</p>} />
        <Route path="/reader" element={<ReaderScreen archiveId="ends" title="Ends" pages={pages} direction={direction} layout="single" />} />
      </Routes>
    </MemoryRouter>);
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const track = reader.querySelector('.reader-track') as HTMLElement;
    const animation = { cancel: vi.fn(), onfinish: undefined as (() => void) | undefined };
    const animate = vi.fn((_frames: Keyframe[], _options?: KeyframeAnimationOptions) => animation);
    Object.defineProperty(track, 'animate', { value: animate, configurable: true });
    const backDx = direction === 'ltr' ? 1500 : -1500;
    fireEvent.touchStart(reader, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: 200 + backDx, clientY: 300 }] });
    act(() => vi.advanceTimersByTime(32));
    const displacement = Number(track.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1]);
    expect(Math.abs(displacement)).toBeLessThanOrEqual(64);
    expect(reader.querySelector('.reader-exit-hint')).toHaveAttribute('data-visible', 'false');
    fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: 200 + backDx, clientY: 300 }] });
    expect(animate.mock.calls[0]![0][1]).toEqual({ transform: 'translate3d(0px,0,0)' });
    act(() => animation.onfinish?.());
    expect(screen.getByRole('main', { name: '漫画阅读器' })).toBeInTheDocument();
    const key = direction === 'ltr' ? 'ArrowRight' : 'ArrowLeft';
    fireEvent.keyDown(reader, { key }); fireEvent.keyDown(reader, { key });
    fireEvent.touchStart(reader, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: 200 - backDx, clientY: 300 }] });
    fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: 200 - backDx, clientY: 300 }] });
    expect(animate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('returned to library')).toBeInTheDocument();
    await act(async () => {});
    view.unmount();
    vi.useRealTimers();
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
    ], expect.objectContaining({ duration: expect.any(Number) }));
    const duration = (animate.mock.calls[0] as unknown as [unknown, KeyframeAnimationOptions])[1].duration as number;
    expect(duration).toBeGreaterThanOrEqual(90);
    expect(duration).toBeLessThanOrEqual(220);
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    act(() => animation.onfinish?.());
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    expect(track.style.transform).toBe('translate3d(0,0,0)');
  });

  it('accepts another touch swipe before the previous landing animation completes', () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const track = reader.querySelector('.reader-track') as HTMLDivElement;
    const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | undefined }[] = [];
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: undefined as (() => void) | undefined };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(track, 'animate', { value: animate, configurable: true });
    const swipe = () => {
      fireEvent.touchStart(reader, { touches: [{ clientX: 340, clientY: 400 }] });
      fireEvent.touchMove(reader, { touches: [{ clientX: 100, clientY: 400 }] });
      fireEvent.touchEnd(reader, { changedTouches: [{ clientX: 100, clientY: 400 }] });
    };
    swipe();
    expect(screen.getByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    const oldFinish = animations[0]!.onfinish;
    swipe();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    // A stale completion from the interrupted animation must not turn twice.
    act(() => oldFinish?.());
    expect(screen.getByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    act(() => animations[1]!.onfinish?.());
    expect(screen.getByRole('img', { name: '第 3 页' })).toBeInTheDocument();
  });

  it('zooms the incoming page when both fingers land during a committed slide', async () => {
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const track = reader.querySelector('.reader-track') as HTMLDivElement;
    const slide = { cancel: vi.fn(), onfinish: undefined as (() => void) | undefined };
    Object.defineProperty(track, 'animate', { value: () => slide, configurable: true });
    fireEvent.touchStart(reader, { touches: [{ clientX: 340, clientY: 400 }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: 100, clientY: 400 }] });
    fireEvent.touchEnd(reader, { changedTouches: [{ clientX: 100, clientY: 400 }] });
    const finish = slide.onfinish;
    fireEvent.touchStart(reader, { touches: [{ clientX: 200, clientY: 400 }, { clientX: 300, clientY: 400 }] });
    const frame = reader.querySelector<HTMLElement>('[aria-label="分页阅读"] > div');
    expect(frame?.querySelector('img')).toHaveAttribute('alt', '第 2 页');
    fireEvent.touchMove(reader, { touches: [{ clientX: 150, clientY: 400 }, { clientX: 350, clientY: 400 }] });
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(frame?.style.transform).toContain('scale(2)');
    fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: 150, clientY: 400 }] });
    act(() => finish?.());
    expect(frame?.querySelector('img')).toHaveAttribute('alt', '第 2 页');
  });

  it('allows a damped undershoot but settles back to 100 percent', () => {
    vi.useFakeTimers();
    const view = renderReader();
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      const frame = reader.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
      fireEvent.wheel(reader, { deltaY: 120 });
      act(() => vi.advanceTimersToNextFrame());
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
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageDown' });
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
    const buttons = within(toolbar).getAllByRole('button');
    // 集合为空时下面的循环体一次都不跑，断言就成了摆设。
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
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
    markImagesReady(container);

    fireEvent.wheel(screen.getByRole('main', { name: '漫画阅读器' }), { deltaY: -120 });
    await act(async () => { await new Promise(requestAnimationFrame); });
    const magnified = zoomed().style.transform;
    expect(magnified).toMatch(/scale\(1\.19/);

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
    expect(zoomed().style.transform).toBe(magnified);
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

    // 这一套用例的视口是 390×844（见文件顶部），单页那一格就是它。700×1000 按
    // contain 贴合：贴住宽度（390），高度按比例 557。
    const plain = screen.getByRole('img', { name: '第 1 页' });
    measure(plain, 700, 1000);
    expect(plain.style.getPropertyValue('--reader-page-fit-width')).toBe('390px');
    expect(plain.style.getPropertyValue('--reader-page-fit-height')).toBe('557px');

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
    expect(enhanced.style.getPropertyValue('--reader-page-fit-width')).toBe('390px');
    expect(enhanced.style.getPropertyValue('--reader-page-fit-height')).toBe('557px');
  });

  it('blows a page smaller than the viewport up to fill it', () => {
    render(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} />
      </MemoryRouter>,
    );
    const page = screen.getByRole('img', { name: '第 1 页' });
    // 300×400 的小图在 390×844 里按 contain 贴合 = 390×520：**两个方向都比自然尺寸大**。
    // 只写 `max-width`/`max-height` 是做不到的——它们只能缩小，这张图会保持 300×400、
    // 四周全是黑边，那正是用户报的那一条。
    Object.defineProperty(page, 'naturalWidth', { configurable: true, value: 300 });
    Object.defineProperty(page, 'naturalHeight', { configurable: true, value: 400 });
    fireEvent.load(page);
    expect(page.style.getPropertyValue('--reader-page-fit-width')).toBe('390px');
    expect(page.style.getPropertyValue('--reader-page-fit-height')).toBe('520px');
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

  it('follows the PhotoView zoom steps starting between two levels', async () => {
    const { container } = renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const zoomed = () => container.querySelector('.reader-single, .reader-spread') as HTMLElement;

    fireEvent.wheel(reader, { deltaY: -200 });
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(zoomed().style.transform).toMatch(/scale\(1\./);
    for (const scale of [1.75, 3, 1]) {
      fireEvent.doubleClick(reader);
      expect(zoomed().style.transform).toContain(`scale(${scale})`);
    }
  });

  // 用户报的：阅读模式是整屏的，自绘标题栏（唯一能拖窗口的地方）被它盖住，于是
  // 那一屏没法移动窗口。阅读态的顶栏现在铺外套那套手势：空处按下＝原生拖动，
  // 双击＝最大化，并且**就地吃掉**这一下——根部还有一个「双击回到原始比例」的
  // 处理器，点在栏上不该顺手把画布比例也翻一遍。
  it('drags and maximizes the native window from the reader top bar', async () => {
    const invoke = vi.fn(() => Promise.resolve(false));
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const view = renderReader();
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      const zoomed = () => view.container.querySelector('.reader-single, .reader-spread') as HTMLElement;
      fireEvent.click(reader);
      const bar = view.container.querySelector('.reader-chrome-top') as HTMLElement;
      expect(bar).not.toBeNull();

      // 先把比例从 1 挪开：这样「双击有没有漏到画布上」才看得出来。
      fireEvent.wheel(reader, { deltaY: -200 });
      await act(async () => { await new Promise(requestAnimationFrame); });
      expect(zoomed().style.transform).not.toContain('scale(1)');

      const title = bar.querySelector('strong') as HTMLElement;
      fireEvent.mouseDown(title, { button: 0, detail: 1 });
      expect(invoke).toHaveBeenCalledWith('plugin:window|start_dragging', { label: 'main' });

      invoke.mockClear();
      fireEvent.doubleClick(title);
      expect(invoke).toHaveBeenCalledWith('plugin:window|toggle_maximize', { label: 'main' });
      expect(zoomed().style.transform).not.toContain('scale(1)');

      // 栏上的按钮不吃这一下：按返回不该顺手把窗口拖走。
      invoke.mockClear();
      fireEvent.mouseDown(screen.getByRole('button', { name: '返回上一页' }), { button: 0, detail: 1 });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  // 用户报的：在顶栏/底栏上双击，会让它下面的图缩放一次（事件穿透）。上面那条用例
  // 量不到它——顶栏那两下手势自己 `stopPropagation` 了，它在乎的是**没有漏到画布上**
  // 这一件事实；漏的是另外两条路：底栏根本没铺那两下手势，而顶栏铺了却在碰到控件时
  // 早退（`isControl`）。所以这一条把落点放在底栏的空白处与顶栏的按钮上。
  it('keeps a double click on either bar off the page underneath it', async () => {
    const invoke = vi.fn(() => Promise.resolve(false));
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const view = renderReader();
    try {
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      const zoomed = () => view.container.querySelector('.reader-single, .reader-spread') as HTMLElement;
      fireEvent.click(reader);
      const bottom = view.container.querySelector('.reader-toolbar') as HTMLElement;
      expect(bottom).not.toBeNull();

      // 先把比例从 1 挪开：这样「双击有没有漏到画布上」才看得出来。
      fireEvent.wheel(reader, { deltaY: -200 });
      await act(async () => { await new Promise(requestAnimationFrame); });
      const anchored = zoomed().style.transform;
      expect(anchored).not.toContain('scale(1)');

      // 底栏三条分组之间的空处。
      fireEvent.doubleClick(bottom);
      expect(zoomed().style.transform).toBe(anchored);

      // 顶栏那颗按钮：`useWindowDrag` 碰到控件会早退，这一下同样会漏。
      fireEvent.doubleClick(screen.getByRole('button', { name: '缩略面板' }));
      expect(zoomed().style.transform).toBe(anchored);

      // 顶栏标题那一行：这一条以前靠 `windowDrag` 的 `stopPropagation` 挡着，
      // 换成栏自己的那一层守卫之后必须仍然挡住。
      fireEvent.doubleClick(view.container.querySelector('.reader-chrome-top strong') as HTMLElement);
      expect(zoomed().style.transform).toBe(anchored);
    } finally {
      view.unmount();
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
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
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '关闭超分' }));
    expect(toggleUpscale).toHaveBeenCalledTimes(1);
  });

  it('toggles the enhancement fill layer without changing the icon contour', () => {
    const reader = (active: boolean) => <MemoryRouter><ReaderScreen archiveId="a1" title="Test archive" pages={pages}
      upscale={{ configured: true, active, toggle: () => undefined }}
      dlssnr={{ configured: true, active, toggle: () => undefined }} /></MemoryRouter>;
    const { rerender } = render(reader(false));
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    const icon = (label: string) => screen.getByRole('button', { name: label }).querySelector('svg')!;
    const upscale = icon('开启超分');
    const dlssnr = icon('开启 DLSSNR');
    expect(upscale).toHaveAttribute('data-icon-state', 'outline');
    expect(dlssnr).toHaveAttribute('data-icon-state', 'outline');
    const upscaleFill = upscale.querySelector('.enhancement-icon-fill');
    const dlssnrFill = dlssnr.querySelector('.enhancement-icon-fill');
    rerender(reader(true));
    expect(icon('关闭超分').querySelector('.enhancement-icon-fill')).toBe(upscaleFill);
    expect(icon('关闭 DLSSNR').querySelector('.enhancement-icon-fill')).toBe(dlssnrFill);
    expect(upscale).toHaveAttribute('data-icon-state', 'filled');
    expect(dlssnr).toHaveAttribute('data-icon-state', 'filled');
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
    expect(loadPage).toHaveBeenCalledWith(0, expect.any(AbortSignal));
    expect(loadPage.mock.calls.some(([index]) => index === 59)).toBe(false);
  });

  it('retires obsolete loads during rapid navigation without poisoning a return to that page', async () => {
    const signals = new Map<number, AbortSignal[]>();
    const loadPage = vi.fn((index: number, signal?: AbortSignal) => {
      signals.set(index, [...(signals.get(index) ?? []), signal!]);
      return index >= 8 ? Promise.resolve(`blob:page-${index}`) : new Promise<string>(() => {});
    });
    const view = render(<MemoryRouter><ReaderScreen archiveId="a" title="Reader" pages={Array.from({ length: 15 }, () => '')}
      layout="single" direction="ltr" prefetchDistance={1} loadPage={loadPage} /></MemoryRouter>);
    await waitFor(() => expect(signals.has(0)).toBe(true));
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    for (let i = 0; i < 8; i += 1) fireEvent.keyDown(reader, { key: 'ArrowRight' });
    expect(await screen.findByRole('img', { name: '第 9 页' })).toHaveAttribute('src', 'blob:page-8');
    expect(signals.get(0)![0]!.aborted).toBe(true);
    for (let i = 0; i < 8; i += 1) fireEvent.keyDown(reader, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(signals.get(0)!.length).toBeGreaterThanOrEqual(2);
      expect(signals.get(0)!.at(-1)!.aborted).toBe(false);
    });
    view.unmount();
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

  it.each(['failed', 'timed out'] as const)('retries a %s page without requiring navigation', async (failure) => {
    vi.useFakeTimers();
    const loadPage = vi.fn<() => Promise<string | undefined>>()
      .mockImplementationOnce(() => failure === 'failed' ? Promise.resolve(undefined) : new Promise(() => {}))
      .mockResolvedValue('blob:recovered');
    const view = render(<MemoryRouter><ReaderScreen archiveId="a" title="Reader" pages={['']} loadPage={loadPage} /></MemoryRouter>);
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(loadPage).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status', { name: '正在加载' })).toBeInTheDocument();
      if (failure === 'timed out') await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(loadPage).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:recovered');
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it('keeps the same full-resolution image during touch and never creates a reduced gesture canvas', async () => {
    const bitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmap);
    const view = renderReader();
    try {
      const image = screen.getByRole('img', { name: '第 1 页' });
      const source = image.getAttribute('src');
      fireEvent.load(image);
      Object.defineProperties(image, {
        naturalWidth: { configurable: true, value: 6000 },
        naturalHeight: { configurable: true, value: 8000 },
      });
      fireEvent.load(image);
      const reader = screen.getByRole('main', { name: '漫画阅读器' });
      fireEvent.touchStart(reader, { touches: [{ clientX: 100, clientY: 400 }, { clientX: 200, clientY: 400 }] });
      fireEvent.touchMove(reader, { touches: [{ clientX: 75, clientY: 400 }, { clientX: 225, clientY: 400 }] });
      await act(async () => { await new Promise(requestAnimationFrame); });
      expect(screen.getByRole('img', { name: '第 1 页' })).toBe(image);
      expect(image).toHaveAttribute('src', source);
      expect(view.container.querySelector('canvas')).toBeNull();
      fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: 75, clientY: 400 }] });
      expect(bitmap).not.toHaveBeenCalled();
    } finally { view.unmount(); vi.unstubAllGlobals(); }
  });

  it('blocks wheel, double click and pinch zoom until the current image has loaded', async () => {
    const { container } = renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const image = screen.getByRole('img', { name: '第 1 页' });
    Object.defineProperties(image, {
      complete: { configurable: true, value: false },
      naturalWidth: { configurable: true, value: 0 },
    });
    const frame = container.querySelector('[aria-label="分页阅读"] > div') as HTMLElement;
    fireEvent.wheel(reader, { deltaY: -120 });
    fireEvent.doubleClick(reader, { clientX: 195, clientY: 400 });
    fireEvent.touchStart(reader, { touches: [{ clientX: 100, clientY: 400 }, { clientX: 200, clientY: 400 }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: 50, clientY: 400 }, { clientX: 250, clientY: 400 }] });
    fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: 50, clientY: 400 }] });
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(frame.style.transform).toBe('scale(1) translate(0px, 0px)');
    markImagesReady(container);
    fireEvent.doubleClick(reader, { clientX: 195, clientY: 400 });
    expect(frame.style.transform).toContain('scale(1.75)');
  });

  it('continues the same pinch when the incoming page finishes loading between touch samples', () => {
    const { container } = renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    const image = screen.getByRole('img', { name: '第 2 页' });
    Object.defineProperty(image, 'complete', { configurable: true, value: false });
    const frame = image.closest('.reader-single') as HTMLElement;
    fireEvent.touchStart(reader, { touches: [{ clientX: 100, clientY: 200 }, { clientX: 200, clientY: 200 }] });
    fireEvent.touchMove(reader, { touches: [{ clientX: 90, clientY: 200 }, { clientX: 210, clientY: 200 }] });
    expect(frame.style.transform).toContain('scale(1)');
    markImagesReady(container);
    fireEvent.touchMove(reader, { touches: [{ clientX: 60, clientY: 200 }, { clientX: 240, clientY: 200 }] });
    expect(frame.style.transform).toContain('scale(1.5)');
    fireEvent.touchEnd(reader, { touches: [] });
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
    // 超分/DLSSNR 在本机跑一页要好几秒，两样一起近二十秒。这段时间屏幕上从前什么
    // 都没有——按下去像没反应，用户看到的就是「按钮点了没动静」。胶囊只说在算。
    const view = render(
      <MemoryRouter>
        <ReaderScreen
          archiveId="a1"
          title="Test archive"
          pages={pages}
          derivedPages={new Map()}
          derivingPages={new Set([0])}
          derivingLabel="超分处理中…"
        />
      </MemoryRouter>,
    );
    const pill = await screen.findByRole('status');
    expect(pill).toHaveTextContent('超分处理中…');

    // 处理完了（产物换上去、或者失败退到原图）就不再压着那句话。
    view.rerender(
      <MemoryRouter>
        <ReaderScreen archiveId="a1" title="Test archive" pages={pages} derivedPages={new Map()} derivingPages={new Set()} derivingLabel="超分处理中…" />
      </MemoryRouter>,
    );
    expect(screen.queryByText('超分处理中…')).not.toBeInTheDocument();
  });

  it('drops the fullscreen control and keeps the counter in the middle slot', async () => {
    const user = userEvent.setup();
    renderReader();

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    const toolbar = screen.getByRole('toolbar', { name: '阅读控制' });
    // 三段式网格：左=布局/方向，中=页码，右=画面处理。底栏那颗「全屏」去掉了——它和
    // 顶栏的「最大化窗口」是同一枚方形图标，被当成重复的那一颗（其实一个是 HTML
    // Fullscreen API、一个是 Tauri 的 toggle_maximize，但重复的观感是真的）。
    expect([...toolbar.children].map((group) => group.className)).toEqual([
      'reader-toolbar-group reader-toolbar-layout',
      'reader-toolbar-group reader-toolbar-pages',
      'reader-toolbar-group reader-toolbar-processing',
    ]);
    expect(within(toolbar).queryByRole('button', { name: '全屏' })).not.toBeInTheDocument();
    expect(within(toolbar).queryByRole('button', { name: '退出全屏' })).not.toBeInTheDocument();
    expect(within(toolbar).getByText('1 / 3')).toBeInTheDocument();
    expect(within(toolbar).queryByRole('button', { name: /^(上一页|下一页)$/ })).not.toBeInTheDocument();
  });

  it('answers every turn of the page with a fresh cue on the bottom bar', async () => {
    const user = userEvent.setup();
    renderReader();
    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    const toolbar = screen.getByRole('toolbar', { name: '阅读控制' });
    // 还没翻过页：光线那个元素不该在（栏自己的进场动画与它不是一件事）。
    expect(toolbar.querySelector('.reader-toolbar-turn')).toBeNull();

    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageDown' });
    const first = toolbar.querySelector('.reader-toolbar-turn');
    expect(first).not.toBeNull();

    // 每翻一页得是一个**新元素**：重挂载才是重播一条 CSS 动画，改属性值不是——实测
    // （debug_outputs/reader-motion）里只把属性在两个值之间轮流，第二页一条动画都没跑。
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageDown' });
    const second = toolbar.querySelector('.reader-toolbar-turn');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);

    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageUp' });
    expect(toolbar.querySelector('.reader-toolbar-turn')).not.toBe(second);
  });

  it('does not replay the turn cue when the bottom bar comes back', async () => {
    const user = userEvent.setup();
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    await user.click(reader);
    const toolbar = screen.getByRole('toolbar', { name: '阅读控制' });
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageDown' });
    expect(toolbar.querySelector('.reader-toolbar-turn')).not.toBeNull();

    // 收起来：底栏是条件挂载，260ms 退场窗口过去之后整棵子树摘掉。
    await user.click(reader);
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 320); }); });
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();

    // 再唤出来：这是一次「栏回来」，不是一次翻页。原来 `turnCue > 0` 让栏带着上一次的
    // 光线一起回来，一次性动画重播 ⇒ 栏顶闪一条主题色的线（用户报的就是这一下）。
    await user.click(reader);
    const again = screen.getByRole('toolbar', { name: '阅读控制' });
    expect(again.querySelector('.reader-toolbar-turn')).toBeNull();

    // 真翻一页还是要回应。
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageDown' });
    expect(again.querySelector('.reader-toolbar-turn')).not.toBeNull();
  });

  it('hides the page pill while the bar is up instead of lifting it over the bar', async () => {
    const user = userEvent.setup();
    renderReader();
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    // 栏出来之前胶囊是在的——这是判据的下限：不然「栏在时不可见」可以靠永远不可见蒙过去。
    expect(pageIndicator()).toHaveAttribute('data-visible', 'true');

    await user.click(reader);
    const pill = pageIndicator() as HTMLElement;
    // 2026-10-15 用户要求：底栏一出现，页码就让位。原来是把胶囊抬到栏顶
    // （`is-raised`），那只是把重叠换了个高度——两块小台面同时抢同一块地方。
    expect(pill).toHaveAttribute('data-visible', 'false');
    expect(pill).not.toHaveClass('is-raised');

    // 收起。退场这 260ms 里栏还挂在树上淡出，胶囊比它高一层——它这时必须继续安静，
    // 并认领 `is-leaving`（样式里跟着栏一起淡出），否则它会从栏顶滑到屏幕底，
    // 一路横穿整条栏（user report:「底栏消失时看起来会有两层底栏」）。
    await user.click(reader);
    const leavingPill = pageIndicator() as HTMLElement;
    expect(screen.getByRole('toolbar', { name: '阅读控制' })).toBeInTheDocument();
    expect(leavingPill).toHaveAttribute('data-visible', 'false');
    expect(leavingPill).toHaveClass('is-leaving');

    // 窗口过去之后栏摘掉，胶囊也交还标记——它此时已经在落点上了，可以正常淡入。
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 320); }); });
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    const rested = pageIndicator() as HTMLElement;
    expect(rested).not.toHaveClass('is-leaving');
    expect(rested).toHaveAttribute('data-visible', 'true');
  });

  it('still shows the turn cue when React renders the screen twice', async () => {
    // `main.tsx` 挂着 StrictMode，开发与测试都是双渲染。光线「这一轮该不该播」如果是在
    // 渲染期间记账的（`playedCue.current = turnCue` 直接写在渲染体里），第二次渲染就已经
    // 记成「播过」了，提交出去的那一棵里没有光线——所以那笔账必须由 effect 记。
    const user = userEvent.setup();
    render(
      <StrictMode>
        <MemoryRouter>
          <ReaderScreen archiveId="a1" title="Test archive" pages={pages} />
        </MemoryRouter>
      </StrictMode>,
    );
    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    const toolbar = screen.getByRole('toolbar', { name: '阅读控制' });
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'PageDown' });
    expect(toolbar.querySelector('.reader-toolbar-turn')).not.toBeNull();
  });

  it('moves the thumbnail panel from the toolbar up to the top bar', async () => {
    const user = userEvent.setup();
    renderReader();

    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    const top = document.querySelector('.reader-chrome-top') as HTMLElement;
    const thumbnailButton = within(top).getByRole('button', { name: '缩略面板' });
    // 它是顶栏里唯一有开/关状态的一颗（按下换 primary，见 design-system 契约测试）。
    expect(thumbnailButton).toHaveAttribute('aria-pressed', 'false');
    expect(within(screen.getByRole('toolbar', { name: '阅读控制' })).queryByRole('button', { name: '缩略面板' }))
      .not.toBeInTheDocument();

    await user.click(thumbnailButton);
    expect(await screen.findByRole('button', { name: '跳转到第 3 页' })).toBeInTheDocument();
    expect(thumbnailButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves auto-play onto whichever side of the toolbar is lighter', async () => {
    const user = userEvent.setup();
    const on = { configured: true, active: false, toggle: () => undefined };
    const autoPlay = () => screen.getByRole('button', { name: /自动翻页/ });
    // 左格固定两枚（布局、方向），右格是开着的增强开关（超分/DLSSNR）。自动翻页要补到
    // **更空**的那一格——判据是数量，不是「有没有开超分」：只开一个开关时右边仍比左边轻，
    // 只按布尔判断会把自动翻页丢到已经更重的一侧去（曾经就是这么写反的）。
    const placement = async (props: { upscale?: typeof on; dlssnr?: typeof on }) => {
      const view = render(
        <MemoryRouter>
          <ReaderScreen archiveId="a1" title="Test archive" pages={pages} {...props} />
        </MemoryRouter>,
      );
      await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
      const placed = {
        layout: document.querySelector('.reader-toolbar-layout')?.contains(autoPlay()) === true,
        processing: document.querySelector('.reader-toolbar-processing')?.contains(autoPlay()) === true,
      };
      view.unmount();
      return placed;
    };

    // 一个都没开：右格是空的 → 自动翻页去右边（2 对 1）。
    expect(await placement({})).toEqual({ layout: false, processing: true });
    // 开一个：右格 1 枚，仍比左格轻 → 继续留在右边（2 对 2）。
    expect(await placement({ upscale: on })).toEqual({ layout: false, processing: true });
    // 开两个：右格 2 枚，轮到左格轻 → 自动翻页回到左边（3 对 2）。
    expect(await placement({ upscale: on, dlssnr: on })).toEqual({ layout: true, processing: false });
  });

  it('keeps the chrome out of the way while the thumbnail panel is open', async () => {
    const user = userEvent.setup();
    renderReader();

    // 面板按钮住在顶栏里，所以先把顶栏从顶带唤出来（底栏这时还是收着的）。
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.mouseMove(reader, { buttons: 0, clientY: 110 });
    expect(screen.queryByRole('toolbar', { name: '阅读控制' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '缩略面板' }));
    expect(await screen.findByRole('button', { name: '跳转到第 3 页' })).toBeInTheDocument();

    // 面板是盖在阅读器上的一层。指针滑到下面的底带时，chrome 自己必须让开：蒙版挡不住
    // hover 判定（判定只看指针坐标），曾经因此能从蒙版上把底栏划出来、顺带把亮着的顶栏撤掉。
    fireEvent.mouseMove(reader, { buttons: 0, clientY: window.innerHeight - 110 });
    expect(screen.queryByRole('toolbar', { name: '阅读控制' })).not.toBeInTheDocument();
    expect(document.querySelector('.reader-chrome-top')).not.toHaveClass('is-leaving');
  });

  it('closes the thumbnail panel from the blank area without toggling the chrome', async () => {
    const user = userEvent.setup();
    renderReader();

    // 顶栏从顶带唤出来（面板按钮住在那里）：底栏这时还没挂载，所以后面那次空白点击
    // 有没有顺手把 chrome 翻一遍，一眼就能看出来。
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.mouseMove(reader, { buttons: 0, clientY: 110 });
    await user.click(screen.getByRole('button', { name: '缩略面板' }));
    await screen.findByRole('button', { name: '跳转到第 3 页' });
    expect(screen.queryByRole('toolbar', { name: '阅读控制' })).not.toBeInTheDocument();

    // 面板外的空白。main 在鼠标左键按下时会 `setPointerCapture`，Chromium 于是把这一次
    // click 改派给 main —— 蒙版自己的 onClick 收不到（这才是「点空白关不掉面板」的真正
    // 原因），而 main 的 onClick 还会顺手把 chrome 翻一遍。jsdom 不做指针捕获改派，所以
    // 这里能钉住的是后半条：这次点击只关面板，不得改变 chrome。
    const backdrop = document.querySelector('.reader-overview-backdrop') as HTMLElement;
    await user.click(backdrop);

    expect(screen.queryByRole('button', { name: '跳转到第 3 页' })).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: '阅读控制' })).not.toBeInTheDocument();
  });

  it('draws the top bar maximize control at the same glyph size as the other chrome icons', async () => {
    // 窗口按钮只在 Tauri 外壳里渲染，而且只在 Windows 上（见下下条用例），
    // 所以这里把桥注入 window 之外，还要把平台答出来。
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn((command: string) => Promise.resolve(
        command === 'platform_capabilities'
          ? { ok: true, value: { platform: 'windows', native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: true } }
          : false,
      )),
    };
    const view = renderReader();
    try {
      // 顶栏本身要先唤出来，那两颗窗口按钮才存在（它们只在 chrome 里渲染）。
      await userEvent.setup().click(screen.getByRole('main', { name: '漫画阅读器' }));
      const maximize = await screen.findByRole('button', { name: '最大化窗口' });
      // 触控面仍是共享的那一颗 44px 圆钮……
      expect(maximize).toHaveClass('reader-icon-button');
      const svg = maximize.querySelector('svg') as SVGSVGElement;
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      // ……里面的方框不能只画 12/24：外壳标题栏那套 `WindowGlyph` 就是 12/24，放进阅读器
      // 顶栏只有邻居（LayoutGrid/Settings）一半大，那才是「最大化按钮尺寸太小」。
      const rect = svg.querySelector('rect') as SVGRectElement;
      expect(Number(rect.getAttribute('width'))).toBeGreaterThanOrEqual(16);
    } finally {
      view.unmount();
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  // 用户报的：手机上阅读模式的顶栏也长着「最大化/最小化」。只看 Tauri 桥是拦不住的
  // ——Android/iOS 上那个桥一样在，而 `plugin:window|toggle_maximize` 在那边是空操作
  // （点了没反应）。所以按钮要正向问平台，而且**首帧就不画**：这一条先点开顶栏、
  // 平台还没答，按钮就得不在（缺陷版此刻已经画出来了），再把「android」答回去，
  // 按钮仍然不在。
  it('leaves the window controls off the top bar where there is no window to maximize', async () => {
    let answerPlatform: ((value: unknown) => void) | undefined;
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn((command: string) => {
        if (command === 'platform_capabilities') {
          return new Promise((resolve) => { answerPlatform = resolve; });
        }
        return Promise.resolve(false);
      }),
    };
    const view = renderReader();
    try {
      await userEvent.setup().click(screen.getByRole('main', { name: '漫画阅读器' }));
      await screen.findByRole('button', { name: '返回上一页' });
      expect(screen.queryByRole('button', { name: '最大化窗口' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '还原窗口' })).not.toBeInTheDocument();

      // 平台答回来了（而且是「手机」），顶栏依旧一颗窗口按钮都没有。
      expect(answerPlatform, '平台没被问到：这条用例就没在测它').toBeTypeOf('function');
      await act(async () => {
        answerPlatform?.({ ok: true, value: { platform: 'android', native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: false } });
      });
      expect(screen.queryByRole('button', { name: '最大化窗口' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '还原窗口' })).not.toBeInTheDocument();
    } finally {
      view.unmount();
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});
