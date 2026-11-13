import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { LibraryWorkspace } from '../../src/components/LibraryWorkspace';
import { RetainedPage } from '../../src/app/RetainedPage';

/** jsdom 不做布局：`clientWidth` / `clientHeight` 恒为 0。而这一轮的生产代码把
 * 「量到 0 就冻结行窗口」（`viewportMeasurable`）也挂在了 `clientWidth` 上——列表
 * 被藏、或被相邻面板夹成 0 宽时它才是真的 0。假件必须按同一口径答：普通元素给
 * 一个视口尺寸，`[hidden]` 子树里仍然是 0（`display:none` 的真行为）。 */
const LAYOUT = { width: 720, height: 560 };

function installLayoutDoubles(): () => void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = (['clientWidth', 'clientHeight'] as const)
    .map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const);
  const size = (element: HTMLElement, value: number) => (element.closest('[hidden]') ? 0 : value);
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return size(this, LAYOUT.width); } });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get(this: HTMLElement) { return size(this, LAYOUT.height); } });
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete proto[name];
    }
  };
}

let restoreLayout: () => void = () => undefined;
beforeEach(() => { restoreLayout = installLayoutDoubles(); });
afterEach(() => { restoreLayout(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('updates virtual rows and loads more when the compact page scrolls', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const more = vi.fn();
  const archives = Array.from({ length: 100 }, (_, i) => ({ serverId: 's', archiveId: `a${i}`, title: `Scroll archive ${i}`, pageCount: 10, updatedAt: '2026-10-14' }));
  let page: HTMLElement;
  const content = <main className="workspace" style={{ overflowY: 'auto' }} ref={(node) => {
    if (!node) return;
    page = node;
    Object.defineProperties(node, { clientHeight: { value: 560 }, scrollHeight: { value: 16600 }, offsetHeight: { value: 560 }, offsetWidth: { value: 720 } });
    node.getBoundingClientRect = () => ({ top: 0, left: 0, width: 720, height: 560, bottom: 560, right: 720, x: 0, y: 0, toJSON() {} });
  }}><LibraryWorkspace archives={archives} showDetail={false} hasMore onLoadMore={more} /></main>;
  const view = render(<MemoryRouter><RetainedPage active>{content}</RetainedPage></MemoryRouter>);
  expect(screen.queryByRole('button', { name: /^Scroll archive 48\b/ })).not.toBeInTheDocument();
  act(() => { page.scrollTop = 8000; fireEvent.scroll(page); });
  await waitFor(() => expect(screen.getByRole('button', { name: /^Scroll archive 48\b/ })).toBeInTheDocument());
  act(() => { page.scrollTop = 16200; fireEvent.scroll(page); });
  await waitFor(() => expect(more).toHaveBeenCalled());
  more.mockClear();
  view.rerender(<MemoryRouter><RetainedPage active={false}>{content}</RetainedPage></MemoryRouter>);
  act(() => { fireEvent.scroll(page); });
  expect(more).not.toHaveBeenCalled();
});

it('rebinds replaced list nodes when crossing the compact breakpoint without resize', async () => {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const media = { matches: false, addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener), removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener) };
  vi.stubGlobal('matchMedia', () => media);
  const more = vi.fn();
  const archives = Array.from({ length: 100 }, (_, i) => ({ serverId: 's', archiveId: `a${i}`, title: `Transition archive ${i}`, pageCount: 10, updatedAt: '2026-10-14' }));
  const { container } = render(<MemoryRouter><main className="workspace" style={{ overflowY: 'auto' }} ref={(node) => {
    if (!node) return;
    Object.defineProperties(node, { clientHeight: { value: 560 }, scrollHeight: { value: 16600 }, offsetHeight: { value: 560 }, offsetWidth: { value: 720 } });
  }}><LibraryWorkspace archives={archives} showDetail={false} hasMore onLoadMore={more} /></main></MemoryRouter>);
  const oldList = container.querySelector<HTMLElement>('[data-scroll-region]')!;
  oldList.style.overflowY = 'auto';
  Object.defineProperties(oldList, { clientHeight: { value: 560 }, scrollHeight: { value: 16600 } });
  act(() => { fireEvent.resize(window); });
  act(() => { media.matches = true; listeners.forEach((listener) => listener({ matches: true })); });
  expect(oldList?.isConnected).toBe(false);
  const page = container.querySelector('main')!;
  act(() => { page.scrollTop = 8000; fireEvent.scroll(page); });
  await waitFor(() => expect(screen.getByRole('button', { name: /^Transition archive 48\b/ })).toBeInTheDocument());
  act(() => { page.scrollTop = 16200; fireEvent.scroll(page); });
  expect(more).toHaveBeenCalled();
  page.scrollTop = 0;
  act(() => { media.matches = false; listeners.forEach((listener) => listener({ matches: false })); });
  const list = container.querySelector('[data-scroll-region]')!;
  expect(list).not.toBe(oldList);
  // The replacement desktop list must own a new pull listener too.
  const start = new Event('touchstart', { bubbles: true });
  Object.defineProperty(start, 'touches', { value: [{ clientY: 0 }] });
  fireEvent(list, start);
  const move = new Event('touchmove', { bubbles: true, cancelable: true });
  Object.defineProperty(move, 'touches', { value: [{ clientY: 200 }] });
  fireEvent(list, move);
  expect(move.defaultPrevented).toBe(true);
});

it('only claims its active subtree gestures and cancels pulls on deactivation', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const refresh = vi.fn();
  const archives = [{ serverId: 's', archiveId: 'a', title: 'Gesture archive', pageCount: 10, updatedAt: '2026-10-14' }];
  const content = (active: boolean) => <MemoryRouter><main className="workspace" style={{ overflowY: 'auto' }}><RetainedPage active={active}><LibraryWorkspace archives={archives} showDetail={false} onRefresh={refresh} /></RetainedPage><button>Visible sibling</button></main></MemoryRouter>;
  const view = render(content(true));
  await act(async () => { await new Promise(requestAnimationFrame); });
  const pull = (target: Element) => {
    fireEvent.touchStart(target, { touches: [{ clientY: 0 }] });
    return fireEvent.touchMove(target, { touches: [{ clientY: 200 }] });
  };
  expect(pull(screen.getByRole('button', { name: 'Visible sibling' }))).toBe(true);
  fireEvent.touchEnd(screen.getByRole('button', { name: 'Visible sibling' }));
  expect(refresh).not.toHaveBeenCalled();
  const card = screen.getByRole('button', { name: /^Gesture archive\b/ });
  expect(pull(card)).toBe(false);
  fireEvent.touchEnd(card);
  expect(refresh).toHaveBeenCalledTimes(1);
  refresh.mockClear();
  pull(card);
  view.rerender(content(false));
  fireEvent.touchEnd(card);
  expect(pull(card)).toBe(true);
  fireEvent.touchEnd(card);
  expect(refresh).not.toHaveBeenCalled();
  view.rerender(content(true));
  fireEvent.touchEnd(card);
  expect(refresh).not.toHaveBeenCalled();
});
