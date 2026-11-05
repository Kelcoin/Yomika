import { rubberBand } from '../../src/lib/motion';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/components/AppShell';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
vi.mock('../../src/app/preferences', () => ({ usePreferences: () => ({ preferences: { ...DEFAULT_PREFERENCES, floatingNav: true } }) }));
beforeEach(() => { vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1; }); });
afterEach(() => vi.restoreAllMocks());
function renderShell() {
  render(<MemoryRouter><AppShell><div data-testid="content">Content</div><input aria-label="Editor" /><div data-testid="nested" style={{ overflowY: 'auto' }}>Nested</div><div className="library-workspace">Library</div></AppShell></MemoryRouter>);
  const host = document.getElementById('main-content')!;
  host.style.overflowY = 'auto';
  Object.defineProperties(screen.getByTestId('nested'), { clientHeight: { value: 50 }, scrollHeight: { value: 100 } });
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 500 }, scrollHeight: { configurable: true, value: 1000 } });
  return host;
}

it('keeps the dock visible on short pages despite elastic scroll positions', () => {
  const host = renderShell();
  Object.defineProperty(host, 'scrollHeight', { value: 530 });
  const nav = screen.getByRole('navigation', { name: '移动导航' });
  for (const top of [20, 30, 75, 30, -20, 0, 25]) {
    host.scrollTop = top;
    fireEvent.scroll(host);
    expect(nav).not.toHaveClass('is-hidden');
  }
});

it('does not toggle the dock during edge dragging or settling', () => {
  const host = renderShell();
  const nav = screen.getByRole('navigation', { name: '移动导航' });
  host.scrollTop = 100; fireEvent.scroll(host);
  expect(nav).toHaveClass('is-hidden');
  for (const phase of ['dragging', 'settling']) {
    host.dataset.edgeBounce = phase;
    host.scrollTop = 0; fireEvent.scroll(host);
    expect(nav).toHaveClass('is-hidden');
  }
  delete host.dataset.edgeBounce;
  host.scrollTop = 50; fireEvent.scroll(host);
  expect(nav).toHaveClass('is-hidden');
  host.scrollTop = 30; fireEvent.scroll(host);
  expect(nav).not.toHaveClass('is-hidden');
});

it('enters edge feedback in the same native gesture even after touchmove becomes noncancelable', () => {
  const host = renderShell();
  const content = screen.getByTestId('content');
  host.scrollTop = 100;
  fireEvent.touchStart(content, { touches: [{ clientY: 100, clientX: 10 }] });
  host.scrollTop = 0;
  const move = (y: number) => {
    const event = new Event('touchmove', { bubbles: true, cancelable: false });
    Object.defineProperty(event, 'touches', { value: [{ clientY: y, clientX: 10 }] });
    fireEvent(content, event);
  };
  move(200);
  move(240);
  expect(host).toHaveAttribute('data-edge-bounce', 'dragging');
  expect(content.style.translate).toBe(`0 ${rubberBand(40)}px`);
  move(260);
  expect(content.style.translate).toBe(`0 ${rubberBand(60)}px`);
  fireEvent.touchEnd(content);
  expect(host).toHaveAttribute('data-edge-bounce', 'settling');
});
it('places the top button alongside a measured floating bar only when it fits', () => {
  let right = 300;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const nav = this.classList.contains('compact-nav');
    return { left: nav ? 100 : 0, right: nav ? right : 44, top: nav ? 700 : 0, bottom: nav ? 764 : 44, width: nav ? right - 100 : 44, height: nav ? 64 : 44 } as DOMRect;
  });
  renderShell();
  const button = screen.getByRole('button', { name: '返回顶部' });
  expect(button).toHaveAttribute('data-placement', 'beside');
  right = window.innerWidth - 30;
  fireEvent(window, new Event('resize'));
  expect(button).toHaveAttribute('data-placement', 'above');
});
it('anchors the disc to the panel being scrolled and sends that panel home alone', () => {
  // 双页档：两栏各自是滚动容器（`data-scroll-region`）。圆盘从前永远贴窗口右下角，
  // 于是滚左栏时它出现在右栏那一侧，点一下还把两栏一起拉回顶部。
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('compact-nav')) return { left: 100, right: 300, top: 700, bottom: 764, width: 200, height: 64 } as DOMRect;
    if (this.dataset.testid === 'left-panel') return { left: 200, right: 600, top: 100, bottom: 700, width: 400, height: 600 } as DOMRect;
    if (this.dataset.testid === 'right-panel') return { left: 620, right: 1020, top: 100, bottom: 700, width: 400, height: 600 } as DOMRect;
    return { left: 0, right: 44, top: 0, bottom: 44, width: 44, height: 44 } as DOMRect;
  });
  render(
    <MemoryRouter>
      <AppShell>
        <section data-scroll-region data-testid="left-panel" />
        <section data-scroll-region data-testid="right-panel" />
      </AppShell>
    </MemoryRouter>,
  );
  const host = document.getElementById('main-content')!;
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 500 }, scrollHeight: { configurable: true, value: 1000 } });
  const left = screen.getByTestId('left-panel');
  const right = screen.getByTestId('right-panel');
  for (const region of [left, right]) Object.defineProperties(region, { clientHeight: { value: 500 }, scrollHeight: { value: 1000 } });
  const scrollTo = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });

  // 往下滚（圆盘该收起）再往上滚（圆盘该出现，且贴住刚才那一栏）。
  left.scrollTop = 600; fireEvent.scroll(left);
  left.scrollTop = 300; fireEvent.scroll(left);
  const button = screen.getByRole('button', { name: '返回顶部' });
  expect(button).toHaveAttribute('data-placement', 'panel');
  expect(button.style.right).toBe(`${window.innerWidth - 600 + 12}px`);
  expect(button.style.bottom).toBe(`${window.innerHeight - 700 + 12}px`);

  // 点一下只回左栏：右栏与整页都不许动。
  fireEvent.click(button);
  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  expect(scrollTo.mock.instances[0]).toBe(left);

  // 换成滚右栏：圆盘跟过去，点击也换成只回右栏。
  right.scrollTop = 600; fireEvent.scroll(right);
  right.scrollTop = 300; fireEvent.scroll(right);
  expect(button).toHaveAttribute('data-placement', 'panel');
  expect(button.style.right).toBe(`${window.innerWidth - 1020 + 12}px`);
  scrollTo.mockClear();
  fireEvent.click(button);
  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(scrollTo.mock.instances[0]).toBe(right);
});
it('damps only outward edge touches, resets on return and cancel, and leaves editors and nested regions alone', () => {
  const host = renderShell();
  const drag = (target: Element, y: number, x = 0) => fireEvent.touchMove(target, { touches: [{ clientY: y, clientX: x }] });
  const start = (target: Element) => fireEvent.touchStart(target, { touches: [{ clientY: 10, clientX: 0 }] });
  start(host); drag(host, 110);
  expect(screen.getByTestId('content').style.translate).toBe(`0 ${rubberBand(100)}px`);
  drag(host, 10);
  expect(screen.getByTestId('content').style.translate).toBe('0 0px');
  fireEvent.touchCancel(host);
  expect(screen.getByTestId('content').style.translate).toBe('');
  start(host); drag(host, 20, 100);
  expect(screen.getByTestId('content').style.translate).toBe('');
  for (const target of [screen.getByRole('textbox'), screen.getByTestId('nested'), screen.getByText('Library')]) {
    start(target); drag(target, 110); expect(screen.getByTestId('content').style.translate).toBe('');
  }
  host.scrollTop = 200; start(host); drag(host, 110); expect(screen.getByTestId('content').style.translate).toBe('');
  host.scrollTop = 500; start(host); drag(host, -90); expect(screen.getByTestId('content').style.translate).toBe(`0 ${rubberBand(-100)}px`);
  fireEvent.touchEnd(host); expect(screen.getByTestId('content').style.translate).toBe('0 0px');
  expect(host.style.transform).toBe(''); expect(host.style.translate).toBe('');
});

it('uses a vertical overflow:auto region even when both computed axes are auto', () => {
  render(<MemoryRouter><AppShell><section data-scroll-region style={{ overflowX: 'auto', overflowY: 'auto' }}><div data-testid="vertical-content">Vertical</div></section></AppShell></MemoryRouter>);
  const content = screen.getByTestId('vertical-content');
  const region = content.parentElement!;
  Object.defineProperties(region, { clientHeight: { value: 500 }, scrollHeight: { value: 1000 }, clientWidth: { value: 300 }, scrollWidth: { value: 300 } });
  fireEvent.touchStart(content, { touches: [{ clientY: 10, clientX: 0 }] });
  fireEvent.touchMove(content, { touches: [{ clientY: 110, clientX: 0 }] });
  expect(content.style.translate).toBe(`0 ${rubberBand(100)}px`);
  expect(region.style.transform).toBe('');
  fireEvent.touchCancel(content);
  expect(content.style.translate).toBe('');
});

it('remeasures the nav after a hide/show transform transition without resize', () => {
  let top = 700;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const nav = this.classList.contains('compact-nav');
    return { left: nav ? 100 : 0, right: nav ? 300 : 44, top: nav ? top : 0, bottom: nav ? top + 64 : 44, width: nav ? 200 : 44, height: nav ? 64 : 44 } as DOMRect;
  });
  const host = renderShell();
  const button = screen.getByRole('button', { name: '返回顶部' });
  const nav = screen.getByRole('navigation', { name: '移动导航' });
  host.scrollTop = 100; fireEvent.scroll(host);
  expect(nav).toHaveClass('is-hidden');
  top = 800; // The bar has not returned to its settled visible rect yet.
  host.scrollTop = 50; fireEvent.scroll(host);
  expect(nav).not.toHaveClass('is-hidden');
  const transient = button.style.bottom;
  top = 700;
  fireEvent.transitionEnd(nav, { propertyName: 'transform' });
  expect(button.style.bottom).not.toBe(transient);
  expect(button.style.bottom).toBe(`${window.innerHeight - 732 - 22}px`);
});

it('leaves the top button where it was when the floating bar parks instead of sliding it to the corner', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const nav = this.classList.contains('compact-nav');
    return { left: nav ? 100 : 0, right: nav ? 300 : 44, top: nav ? 700 : 0, bottom: nav ? 764 : 44, width: nav ? 200 : 44, height: nav ? 64 : 44 } as DOMRect;
  });
  const host = renderShell();
  const button = screen.getByRole('button', { name: '返回顶部' });
  const nav = screen.getByRole('navigation', { name: '移动导航' });
  expect(button).toHaveAttribute('data-placement', 'beside');
  const parked = { right: button.style.right, bottom: button.style.bottom };
  host.scrollTop = 120;
  fireEvent.scroll(host);
  // 向下滚一次，底栏和圆盘同时进入收起/淡出。
  expect(nav).toHaveClass('is-hidden');
  expect(button).toHaveClass('is-hidden');
  // 淡出期间不许挪位置：贴着胶囊与贴右下角差着几百像素，挪一次就是「往右瞬移再消失」。
  expect(button.style.right).toBe(parked.right);
  expect(button.style.bottom).toBe(parked.bottom);
  // 滚回来时（底栏先回来）照旧重算，冻结不是永久钉死。
  host.scrollTop = 40;
  fireEvent.scroll(host);
  expect(nav).not.toHaveClass('is-hidden');
  expect(button).not.toHaveClass('is-hidden');
  expect(button.style.right).toBe(parked.right);
});

it('keeps the top button parked even when the collapsed bar measures nothing', () => {
  // 收起期间底栏量出 0 宽（换合成层，或者将来某天改成 display:none）。那时该做的是**停在
  // 原地**，而不是把按钮撤掉：撤掉同样会闪一下，只是闪的方向不同。这一段排在「量不到底栏
  // 就隐藏圆盘」之前，判据就是这条顺序。
  let navWidth = 200;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const nav = this.classList.contains('compact-nav');
    return { left: nav ? 100 : 0, right: nav ? 100 + navWidth : 44, top: nav ? 700 : 0, bottom: nav ? 764 : 44, width: nav ? navWidth : 44, height: nav ? 64 : 44 } as DOMRect;
  });
  const host = renderShell();
  const button = screen.getByRole('button', { name: '返回顶部' });
  const nav = screen.getByRole('navigation', { name: '移动导航' });
  expect(button).toHaveAttribute('data-placement', 'beside');
  const parked = { right: button.style.right, bottom: button.style.bottom };
  host.scrollTop = 120;
  fireEvent.scroll(host);
  expect(nav).toHaveClass('is-hidden');
  navWidth = 0;
  fireEvent(window, new Event('resize'));
  expect(screen.getByRole('button', { name: '返回顶部' })).toBe(button);
  expect(button.style.right).toBe(parked.right);
  expect(button.style.bottom).toBe(parked.bottom);
});

it('coalesces card drags into one frame and leaves sideways rails native', () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
  const host = renderShell();
  const card = screen.getByTestId('content');
  card.className = 'archive-rail-grid';
  fireEvent.touchStart(card, { touches: [{ clientY: 10, clientX: 0 }] });
  for (let y = 30; y <= 110; y += 10) fireEvent.touchMove(card, { touches: [{ clientY: y, clientX: 0 }] });
  expect(card.style.translate).toBe('');
  expect(frames).toHaveLength(1);
  frames.shift()!(0);
  expect(card.style.translate).toBe(`0 ${rubberBand(100)}px`);
  fireEvent.touchCancel(card);
  fireEvent.touchStart(card, { touches: [{ clientY: 10, clientX: 0 }] });
  fireEvent.touchMove(card, { touches: [{ clientY: 20, clientX: 100 }] });
  expect(host).not.toHaveAttribute('data-edge-bounce');
});

it('keeps fixed descendants in the viewport and resets before a new overlay paints', async () => {
  const host = renderShell();
  const content = screen.getByTestId('content');
  const fixed = document.createElement('div');
  fixed.style.position = 'fixed';
  content.append(fixed);
  fireEvent.touchStart(content, { touches: [{ clientY: 10, clientX: 0 }] });
  fireEvent.touchMove(content, { touches: [{ clientY: 110, clientX: 0 }] });
  expect(content.style.translate).toBe('');
  expect(content.style.top).toBe(`${rubberBand(100)}px`);
  fireEvent.touchCancel(host);
  fixed.remove();
  fireEvent.touchStart(content, { touches: [{ clientY: 10, clientX: 0 }] });
  fireEvent.touchMove(content, { touches: [{ clientY: 110, clientX: 0 }] });
  expect(content.style.translate).toBe(`0 ${rubberBand(100)}px`);
  content.append(fixed);
  await Promise.resolve();
  expect(content.style.translate).toBe('');
  expect(host).not.toHaveAttribute('data-edge-bounce');
});

it('bounds claim style reads regardless of the content subtree size', () => {
  renderShell();
  const content = screen.getByTestId('content');
  const section = document.createElement('section');
  for (let index = 0; index < 1500; index += 1) section.append(document.createElement('span'));
  const fixed = document.createElement('div');
  fixed.style.position = 'fixed';
  section.append(fixed);
  content.append(section);
  fireEvent.touchStart(content, { touches: [{ clientY: 10, clientX: 0 }] });
  const reads = vi.spyOn(window, 'getComputedStyle');
  fireEvent.touchMove(content, { touches: [{ clientY: 110, clientX: 0 }] });
  expect(reads.mock.calls.length).toBeLessThanOrEqual(16);
  expect(content.style.translate).toBe('');
  expect(content.style.top).toBe(`${rubberBand(100)}px`);
  fireEvent.touchCancel(content);
  expect(content.style.top).toBe('');
});

it('leaves a page with excessive sibling surfaces native instead of blocking input', () => {
  const host = renderShell();
  for (let index = 0; index < 100; index += 1) host.append(document.createElement('div'));
  fireEvent.touchStart(host, { touches: [{ clientY: 10, clientX: 0 }] });
  const reads = vi.spyOn(window, 'getComputedStyle');
  const event = new Event('touchmove', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: [{ clientY: 110, clientX: 0 }] });
  fireEvent(host, event);
  expect(event.defaultPrevented).toBe(false);
  expect(reads).not.toHaveBeenCalled();
  expect(host).not.toHaveAttribute('data-edge-bounce');
});


it('claims a small outward move before native slop, ignoring initial diagonal jitter', () => {
  const host = renderShell();
  fireEvent.touchStart(host, { touches: [{ clientY: 10, clientX: 10 }] });
  fireEvent.touchMove(host, { touches: [{ clientY: 11, clientX: 12 }] });
  expect(host).not.toHaveAttribute('data-edge-bounce');
  const event = new Event('touchmove', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: [{ clientY: 15, clientX: 10 }] });
  fireEvent(host, event);
  expect(event.defaultPrevented).toBe(true);
  expect(host).toHaveAttribute('data-edge-bounce', 'dragging');
});

it('moves a portal-only page without top writes and survives asynchronous card updates', async () => {
  const host = renderShell();
  const content = screen.getByTestId('content');
  content.setAttribute('data-bounce-surface', '');
  content.append(document.createElement('article'));
  fireEvent.touchStart(content, { touches: [{ clientY: 10, clientX: 0 }] });
  fireEvent.touchMove(content, { touches: [{ clientY: 110, clientX: 0 }] });
  expect(content.style.top).toBe('');
  expect(content.style.translate).toBe(`0 ${rubberBand(100)}px`);
  content.firstElementChild!.append(document.createElement('img'));
  await Promise.resolve();
  expect(host).toHaveAttribute('data-edge-bounce', 'dragging');
  expect(content.style.translate).toBe(`0 ${rubberBand(100)}px`);
  fireEvent.touchCancel(content);
  expect(content.style.translate).toBe('');
});

it('does not count hidden cached pages against the visible surface budget', () => {
  const host = renderShell();
  for (let index = 0; index < 24; index += 1) {
    const panel = document.createElement('section');
    panel.hidden = true;
    host.append(panel);
  }
  fireEvent.touchStart(host, { touches: [{ clientY: 10, clientX: 0 }] });
  fireEvent.touchMove(host, { touches: [{ clientY: 110, clientX: 0 }] });
  expect(host).toHaveAttribute('data-edge-bounce', 'dragging');
});

it('anchors the top button to layout coordinates throughout a dock transition', () => {
  let animatedTop = 700;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const nav = this.classList.contains('compact-nav');
    return { left: nav ? 100 : 0, right: nav ? 300 : 44, top: nav ? animatedTop : 0, bottom: nav ? animatedTop + 64 : 44, width: nav ? 200 : 44, height: nav ? 64 : 44 } as DOMRect;
  });
  const host = renderShell();
  const nav = screen.getByRole('navigation', { name: '移动导航' });
  nav.style.bottom = '12px';
  const button = screen.getByRole('button', { name: '返回顶部' });
  fireEvent(window, new Event('resize'));
  const bottom = button.style.bottom;
  host.scrollTop = 100; fireEvent.scroll(host);
  expect(button).toHaveAttribute('data-nav-hidden', 'true');
  animatedTop = 800;
  host.scrollTop = 50; fireEvent.scroll(host);
  expect(button).not.toHaveAttribute('data-nav-hidden');
  expect(button.style.bottom).toBe(bottom);
  fireEvent.transitionEnd(nav, { propertyName: 'transform' });
  expect(button.style.bottom).toBe(bottom);
  expect(button.style.getPropertyValue('--compact-nav-travel')).toBe('76px');
});

it('keeps dock visibility stable for tiny reversals but accumulates slow deliberate scrolling', () => {
  const host = renderShell();
  const nav = screen.getByRole('navigation', { name: '移动导航' });
  const button = screen.getByRole('button', { name: '返回顶部' });
  host.scrollTop = 100; fireEvent.scroll(host);
  expect(nav).toHaveClass('is-hidden');
  host.scrollTop = 98; fireEvent.scroll(host);
  expect(nav).toHaveClass('is-hidden');
  host.scrollTop = 96; fireEvent.scroll(host);
  expect(nav).toHaveClass('is-hidden');
  host.scrollTop = 94; fireEvent.scroll(host);
  expect(nav).not.toHaveClass('is-hidden');
  expect(button).not.toHaveClass('is-hidden');
  host.scrollTop = 96; fireEvent.scroll(host);
  expect(nav).not.toHaveClass('is-hidden');
});

 it('bounces on outward wheel input, smooths discrete scrolling and leaves editors native', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  const host = renderShell();
  const content = screen.getByTestId('content');
  const outward = new WheelEvent('wheel', { deltaY: -60, bubbles: true, cancelable: true });
  host.dispatchEvent(outward);
  expect(outward.defaultPrevented).toBe(true);
  expect(host).toHaveAttribute('data-edge-bounce', 'dragging');
  fireEvent.touchCancel(host);
  host.scrollTop = 100;
  const normal = new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true });
  host.dispatchEvent(normal);
  expect(normal.defaultPrevented).toBe(true);
  expect(content.style.translate).toBe('');
  host.scrollTop = 0;
  fireEvent.wheel(screen.getByRole('textbox'), { deltaY: -60 });
  expect(content.style.translate).toBe('');
 });
