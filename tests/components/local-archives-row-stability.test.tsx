import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { RetainedPage } from '../../src/app/RetainedPage';
import { LocalArchivesWorkspace } from '../../src/components/LocalArchivesWorkspace';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { ARCHIVE_LIST_ROW_STRIDE } from '../../src/lib/archiveGridLayout';

/** jsdom 不做布局，`offsetHeight` 恒为 0，而虚拟器量尺寸就只读这一个属性
 * （`@tanstack/virtual-core` 的 `getRect` → `offsetWidth/offsetHeight`）。所以
 * 「滚动区多高、一行多高」这两件事必须在测试里替 jsdom 答出来，否则虚拟列表
 * 在测试里永远只有一行，量不出「页面被收起来时整屏卸载」这件事。
 *
 * 关键是隐藏时的 0：真浏览器里 `display:none` 的子树量出来就是 0 高
 * （`hidden` 属性同理），ResizeObserver 也会跟着报一次新尺寸。这里把这两条
 * 补上：`[hidden]` 子树里的元素量到 0，且 `hidden` 属性一变就重发一次
 * ResizeObserver 通知（MutationObserver 转过去），剩下的全交给真实组件。 */
const VIEWPORT_HEIGHT = 600;
const VIEWPORT_WIDTH = 720;

type Observer = { callback: ResizeObserverCallback; targets: Set<Element> };

const observers: Observer[] = [];
let mutations: MutationObserver | undefined;
let restoreLayout: () => void = () => undefined;

function resizeEntry(target: Element): ResizeObserverEntry {
  const width = (target as HTMLElement).clientWidth;
  const height = (target as HTMLElement).clientHeight;
  return { target, borderBoxSize: [{ inlineSize: width, blockSize: height }],
    contentBoxSize: [{ inlineSize: width, blockSize: height }],
    contentRect: { width, height } } as unknown as ResizeObserverEntry;
}

function notifyObservers() {
  for (const observer of observers) {
    for (const target of observer.targets) {
      if (!target.isConnected) continue;
      observer.callback([resizeEntry(target)], observer as unknown as ResizeObserver);
    }
  }
}

function installVirtualLayoutFake() {
  const proto = window.HTMLElement.prototype;
  const offsetWidth = Object.getOwnPropertyDescriptor(proto, 'offsetWidth')!;
  const offsetHeight = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')!;
  const originalResizeObserver = window.ResizeObserver;

  /** 一处尺寸口径，四个属性一起答：虚拟器读 `offset*`，可测性闸门读 `client*`。
   * 只答一半的话 jsdom 会说「视口量到 0 高」，而 0 高在组件里等价于「面板被藏
   * 起来了」——那个闸门会按设计冻结行窗口，于是滚动一条真实布局里该前进的列表
   * 在测试里永远前进不了。 */
  const describeHeight = function describeHeight(this: HTMLElement): number {
    if (this.closest('[hidden]')) return 0;
    if (this.classList.contains('local-archives-list') || this.classList.contains('workspace')) return VIEWPORT_HEIGHT;
    if (this.classList.contains('archive-row-wrap')) return ARCHIVE_LIST_ROW_STRIDE;
    return 0;
  };
  const describeWidth = function describeWidth(this: HTMLElement): number {
    if (this.closest('[hidden]')) return 0;
    if (this.classList.contains('local-archives-list') || this.classList.contains('workspace')) return VIEWPORT_WIDTH;
    return 0;
  };
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return describeHeight.call(this);
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return describeHeight.call(this);
    },
  });
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return describeWidth.call(this);
    },
  });
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return describeWidth.call(this);
    },
  });

  class FakeResizeObserver {
    private readonly observer: Observer;
    constructor(callback: ResizeObserverCallback) {
      this.observer = { callback, targets: new Set() };
      observers.push(this.observer);
    }
    observe(target: Element) {
      this.observer.targets.add(target);
      this.observer.callback([resizeEntry(target)], this as unknown as ResizeObserver);
    }
    unobserve(target: Element) {
      this.observer.targets.delete(target);
    }
    disconnect() {
      this.observer.targets.clear();
    }
  }
  window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

  mutations = new MutationObserver(() => notifyObservers());
  mutations.observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });

  restoreLayout = () => {
    mutations?.disconnect();
    mutations = undefined;
    observers.length = 0;
    Object.defineProperty(proto, 'offsetWidth', offsetWidth);
    Object.defineProperty(proto, 'offsetHeight', offsetHeight);
    // client* 本来住在 Element.prototype 上，我们只是在这层加了自己的那一份：
    // 删掉自有的那份，查找自然落回原型链上的原实现（jsdom 的 0）。
    delete (proto as unknown as Record<string, unknown>).clientWidth;
    delete (proto as unknown as Record<string, unknown>).clientHeight;
    window.ResizeObserver = originalResizeObserver;
  };
}

afterEach(() => {
  restoreLayout();
  resetInvokeAdapterForTests();
});



function localFile(index: number) {
  return {
    path: `E:\\Downloads\\file-${index}.cbz`,
    archiveId: String(index).padStart(40, 'a'),
    serverId: 'server-a',
    scopeId: 'scope-a',
    title: `档案 ${index}`,
    fileSize: 1024,
    // 原生那条查询是 `ORDER BY added_at DESC, path DESC`，列表默认也按
    // 「添加时间 / 降序」排：让序号越小越新，默认次序就和原生一致。
    addedAt: 1_760_000_000_000 - index,
    pageCount: 12,
    tags: [],
  };
}

/** 屏幕上现在挂着哪些行，按虚拟序号索引。 */
function renderedRows(): Map<string, Element> {
  const rows = new Map<string, Element>();
  for (const node of document.querySelectorAll('.archive-row-wrap')) rows.set(node.getAttribute('data-index') ?? '?', node);
  return rows;
}

function Harness({ active }: { active: boolean }) {
  // 真页面的外壳就是这一层：`src/app/routes.tsx:757` 给每个访问过的页面套一个
  // `RetainedPage`，切走时给它加 `hidden`。这里只保留这一个变量。
  return (
    <MemoryRouter initialEntries={['/downloads']}>
      <RetainedPage active={active}><LocalArchivesWorkspace /></RetainedPage>
    </MemoryRouter>
  );
}

describe('local archives rows across a hidden panel', () => {
  it('keeps the rows it had on screen instead of emptying the list while the page is away', async () => {
    installVirtualLayoutFake();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') return { ok: true, value: Array.from({ length: 40 }, (_, index) => localFile(index)) };
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    const { rerender } = render(<Harness active />);
    await screen.findByText('档案 0');
    await waitFor(() => expect(renderedRows().size).toBeGreaterThan(1));
    const onScreen = renderedRows();

    // 切去别的页面：面板被加上 `hidden`，量到的高度变成 0。
    await act(async () => { rerender(<Harness active={false} />); });
    await waitFor(() => expect(document.querySelector('.route-cache-panel')?.hasAttribute('hidden')).toBe(true));
    await act(async () => { await new Promise(requestAnimationFrame); });

    // 藏起来的时候整屏的行不能卸载：它们一卸载，回来那一帧就是一段空列表，
    // 封面、标签、行高全都要重新建一遍——用户看到的就是「固定闪烁」。
    const away = renderedRows();
    expect([...away.keys()].sort()).toEqual([...onScreen.keys()].sort());
    for (const [index, node] of onScreen) expect(away.get(index)).toBe(node);

    await act(async () => { rerender(<Harness active />); });
    await act(async () => { await new Promise(requestAnimationFrame); });

    // 回来之后，还在窗口里的每一行都必须是原来那个 DOM 节点：同一个节点
    // 复用就不会重新取封面。
    const back = renderedRows();
    const shared = [...onScreen.keys()].filter((index) => back.has(index));
    expect(shared.length).toBeGreaterThan(0);
    for (const index of shared) expect(back.get(index)).toBe(onScreen.get(index));
  });
});

it('advances the local virtual window with the compact page scroller', async () => {
  installVirtualLayoutFake();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ media: query, matches: query.includes('max-width'), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true })) as typeof window.matchMedia;
  try {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') return { ok: true, value: Array.from({ length: 80 }, (_, index) => localFile(index)) };
      return { ok: true, value: [] };
    });
    render(<MemoryRouter initialEntries={['/downloads']}><div className="workspace"><LocalArchivesWorkspace /></div></MemoryRouter>);
    await screen.findByText('档案 0');
    const host = document.querySelector<HTMLElement>('.workspace')!;
    Object.defineProperty(host, 'scrollHeight', { configurable: true, value: 80 * ARCHIVE_LIST_ROW_STRIDE });
    fireEvent.scroll(host, { target: { scrollTop: 40 * ARCHIVE_LIST_ROW_STRIDE } });
    await waitFor(() => expect(screen.getByText('档案 40')).toBeInTheDocument());
    expect(screen.queryByText('档案 0')).not.toBeInTheDocument();
  } finally { window.matchMedia = original; }
});
