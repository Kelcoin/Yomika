import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RetainedPage } from '../../src/app/RetainedPage';
import { ArchiveThumbCardBody, ArchiveThumbMeta } from '../../src/components/ArchiveThumbnailCard';
import { CardTagRows } from '../../src/components/CardTagRows';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('lays out thumbnail tags without hidden measurement copies or chip geometry reads', () => {
  const widths = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get');
  const { container, rerender } = render(<ArchiveThumbCardBody title="Archive" tags={['artist:one', 'group:two', 'language:chinese']} meta={<span>235 页</span>} />);
  expect(container.querySelector('.card-tag-measures')).toBeNull();
  expect(container.querySelector('.archive-thumb-card-tags')).toHaveClass('is-wrapped');
  expect(widths).not.toHaveBeenCalled();
  rerender(<ArchiveThumbCardBody title="Archive" tags={['artist:other', 'group:two']} meta={<span>235 页</span>} />);
  expect(container.querySelector('.archive-thumb-card-tags')).toHaveTextContent('other');
  expect(widths).not.toHaveBeenCalled();
});

it('does not measure tags on retained inactive pages, but measures before revealing them', () => {
  const widths = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(70);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(160);
  const tags = ['artist:one', 'group:two', 'language:chinese', 'other:four', 'other:five', 'other:six'];
  const cards = Array.from({ length: 60 }, (_, i) => <CardTagRows key={i} tags={tags} rowCount={2} className="tags" fill />);
  const { rerender, container } = render(<RetainedPage active={false}>{cards}</RetainedPage>);
  expect(widths).toHaveBeenCalledTimes(0);
  rerender(<RetainedPage active>{cards}</RetainedPage>);
  expect(widths.mock.calls.length).toBeGreaterThanOrEqual(360);
  expect(container.querySelectorAll('.archive-row-tag-line')).toHaveLength(120);
});

it('does not read layout for unrelated scroll events while preserving owned scroll positions', () => {
  const { container, rerender } = render(<RetainedPage active><div data-testid="owned" /></RetainedPage>);
  const unrelated = document.createElement('div');
  document.body.append(unrelated);
  try {
    const geometry = vi.spyOn(unrelated, 'getClientRects');
    for (let i = 0; i < 120; i++) fireEvent.scroll(unrelated);
    expect(geometry).toHaveBeenCalledTimes(0);
    const owned = container.querySelector<HTMLElement>('[data-testid="owned"]')!;
    vi.spyOn(owned, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    owned.scrollTop = 240;
    fireEvent.scroll(owned);
    rerender(<RetainedPage active={false}><div data-testid="owned" /></RetainedPage>);
    owned.scrollTop = 0;
    rerender(<RetainedPage active><div data-testid="owned" /></RetainedPage>);
    expect(owned.scrollTop).toBe(240);
  } finally { unrelated.remove(); }
});

it('keeps footer measurement stable across unchanged renders and invalidates on text, width and activation', () => {
  let width = 90;
  const observers: ResizeObserverCallback[] = [];
  const observe = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observers.push(callback); }
    observe = observe;
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  const reads = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(65);
  const footer = (active = true, text = '59/235 页') => <RetainedPage active={active}><ArchiveThumbMeta><span>{text}</span><span>2026-10-12</span></ArchiveThumbMeta></RetainedPage>;
  const { rerender } = render(footer());
  expect(reads.mock.calls.length).toBeGreaterThan(0);
  reads.mockClear();
  for (let i = 0; i < 10; i++) rerender(footer());
  expect(reads).toHaveBeenCalledTimes(0);
  expect(observe).toHaveBeenCalledTimes(1);
  rerender(footer(true, '60/235 页'));
  expect(reads.mock.calls.length).toBeGreaterThan(0);
  reads.mockClear();
  width = 200;
  act(() => observers[0]!([], {} as ResizeObserver));
  expect(reads.mock.calls.length).toBeGreaterThan(0);
  reads.mockClear();
  rerender(footer(false));
  expect(reads).toHaveBeenCalledTimes(0);
  rerender(footer());
  expect(reads.mock.calls.length).toBeGreaterThan(0);
});

it('remeasures unchanged footer text when fonts finish loading and ignores stale font callbacks', async () => {
  const original = Object.getOwnPropertyDescriptor(document, 'fonts');
  let loaded!: () => void;
  const ready = new Promise<void>((resolve) => { loaded = resolve; });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const reads = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(60);
  try {
    const { rerender, unmount } = render(<RetainedPage active><ArchiveThumbMeta><span>235 页</span></ArchiveThumbMeta></RetainedPage>);
    // The old active effect's callback must not run after hiding/revealing.
    rerender(<RetainedPage active={false}><ArchiveThumbMeta><span>235 页</span></ArchiveThumbMeta></RetainedPage>);
    rerender(<RetainedPage active><ArchiveThumbMeta><span>235 页</span></ArchiveThumbMeta></RetainedPage>);
    reads.mockClear();
    await act(async () => { loaded(); await ready; });
    expect(reads).toHaveBeenCalledTimes(1);
    unmount();
  } finally {
    if (original) Object.defineProperty(document, 'fonts', original);
    else Reflect.deleteProperty(document, 'fonts');
  }
});
