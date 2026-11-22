import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ReaderScreen } from '../../src/components/ReaderScreen';
import { setImageDecoderForTests } from '../../src/lib/decodeImage';

afterEach(() => { setImageDecoderForTests(undefined); vi.useRealTimers(); vi.restoreAllMocks(); });

it('preempts slow prefetches still inside the window when an unloaded page becomes visible', async () => {
  const attempts: { index: number; signal: AbortSignal | undefined }[] = [];
  const loadPage = vi.fn((index: number, signal?: AbortSignal) => {
    attempts.push({ index, signal });
    return new Promise<string>(() => {});
  });
  render(<MemoryRouter><ReaderScreen archiveId="priority" title="Priority" pages={['blob:first', '', '', '', '']} layout="single" prefetchDistance={3} loadPage={loadPage} /></MemoryRouter>);
  await waitFor(() => expect(attempts.some(a => a.index === 2)).toBe(true));
  const neighbour = attempts.find(a => a.index === 1)!;
  const prefetch = attempts.find(a => a.index === 2)!;
  fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'ArrowRight' });
  await waitFor(() => expect(prefetch.signal?.aborted).toBe(true));
  expect(neighbour.signal?.aborted).toBe(false);
  expect(attempts.filter(a => a.index === 2)).toHaveLength(2);
});

it('retries a page request that never settles and aborts its old consumer', async () => {
  vi.useFakeTimers();
  let firstSignal: AbortSignal | undefined;
  const loadPage = vi.fn().mockImplementationOnce((_index, signal) => { firstSignal = signal; return new Promise(() => {}); }).mockResolvedValue('blob:recovered');
  render(<MemoryRouter><ReaderScreen archiveId="hung" title="Hung" pages={['']} layout="single" loadPage={loadPage} /></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
  expect(firstSignal?.aborted).toBe(true);
  expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:recovered');
});

it('keeps the next frame available but coalesces distant prefetch across rapid turns', async () => {
  vi.useFakeTimers();
  const loadPage = vi.fn(async (_index: number) => 'blob:prefetched');
  render(<MemoryRouter><ReaderScreen archiveId="burst" title="Burst" pages={['blob:1', 'blob:2', 'blob:3', 'blob:4', '', '', '', '', '']} layout="single" prefetchDistance={3} loadPage={loadPage} /></MemoryRouter>);
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  fireEvent.keyDown(reader, { key: 'ArrowRight' });
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(loadPage).not.toHaveBeenCalled();
  fireEvent.keyDown(reader, { key: 'ArrowRight' });
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(loadPage).not.toHaveBeenCalled();
  fireEvent.keyDown(reader, { key: 'ArrowRight' });
  await act(async () => {});
  expect(loadPage.mock.calls.map(([index]) => index)).toEqual([4]);
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(loadPage.mock.calls.map(([index]) => index)).toEqual([4, 5, 6]);
});

it('bounds a stuck middle page and lets its retry replace the abandoned request', async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(128);
  let recover = false;
  const signals: AbortSignal[] = [];
  const loadPage = vi.fn((_index: number, signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    return recover ? Promise.resolve('blob:recovered-middle') : new Promise<string>(() => {});
  });
  render(<MemoryRouter><ReaderScreen archiveId="middle" title="Middle" pages={['blob:first', '', 'blob:last']} initialPage={1} layout="single" loadPage={loadPage} /></MemoryRouter>);
  for (let elapsed = 0; elapsed < 110_000; elapsed += 5_000) {
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  }
  expect(loadPage).toHaveBeenCalledTimes(3);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(screen.getByRole('button', { name: '重试加载' })).toBeInTheDocument();
  recover = true;
  fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
  await act(async () => {});
  expect(screen.getByRole('img', { name: '第 2 页' })).toHaveAttribute('src', 'blob:recovered-middle');
});

it('retries a rejected request instead of leaving it indefinitely loading', async () => {
  vi.useFakeTimers();
  const loadPage = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue('blob:recovered');
  render(<MemoryRouter><ReaderScreen archiveId="reject" title="Reject" pages={['']} layout="single" loadPage={loadPage} /></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:recovered');
});

it('remeasures indicator overlap when a displayed page loads again without changing its natural size', async () => {
  vi.useFakeTimers();
  render(<MemoryRouter><ReaderScreen archiveId="measure" title="Measure" pages={['blob:plain']} layout="single" /></MemoryRouter>);
  const image = screen.getByRole('img', { name: '第 1 页' });
  Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
  let bottom = 800;
  vi.spyOn(image, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 1000, bottom));
  const pill = document.querySelector('.reader-page-indicator')!;
  vi.spyOn(pill, 'getBoundingClientRect').mockImplementation(() => new DOMRect(900, 700, 80, 30));
  fireEvent.load(image);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(pill).toHaveAttribute('data-visible', 'false');
  bottom = 600;
  fireEvent.load(image);
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  expect(pill).toHaveAttribute('data-visible', 'true');
});

it('offers a retry if the displayed image never emits load or error', async () => {
  vi.useFakeTimers();
  render(<MemoryRouter><ReaderScreen archiveId="image-timeout" title="Image timeout" pages={['blob:never-loads']} layout="single" /></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByRole('button', { name: '重试加载' })).toBeInTheDocument();
});

it('times out a partially loaded neighbour after it becomes the current page', async () => {
  vi.useFakeTimers();
  render(<MemoryRouter><ReaderScreen archiveId="partial-image" title="Partial image" pages={['blob:first', 'blob:partial']} layout="single" /></MemoryRouter>);
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  const image = reader.querySelector<HTMLImageElement>('img[src="blob:partial"]')!;
  Object.defineProperties(image, { naturalWidth: { value: 6000 }, complete: { value: false } });
  fireEvent.keyDown(reader, { key: 'ArrowRight' });
  expect(screen.getByRole('img', { name: '第 2 页' })).toBe(image);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByRole('button', { name: '重试加载' })).toBeInTheDocument();
});

it('keeps a healthy image when candidate decode times out and ignores a late completion', async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  setImageDecoderForTests(() => new Promise<void>((resolve) => { finish = resolve; }));
  const props = { archiveId: 'decode-timeout', title: 'Decode timeout', pages: ['blob:plain'], layout: 'single' as const };
  const view = render(<MemoryRouter><ReaderScreen {...props} /></MemoryRouter>);
  fireEvent.load(screen.getByRole('img', { name: '第 1 页' }));
  view.rerender(<MemoryRouter><ReaderScreen {...props} derivedPages={new Map([[0, 'blob:slow']])} /></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); finish?.(); });
  expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:plain');
  expect(screen.queryByRole('button', { name: '重试加载' })).not.toBeInTheDocument();
});

it('turns a DOM image failure into a page retry that reacquires its handle', async () => {
  const loadPage = vi.fn().mockResolvedValueOnce('blob:broken').mockResolvedValue('blob:fresh');
  const releasePage = vi.fn();
  render(<MemoryRouter><ReaderScreen archiveId="retry" title="Retry" pages={['']} layout="single" loadPage={loadPage} releasePage={releasePage} /></MemoryRouter>);
  fireEvent.error(await screen.findByRole('img', { name: '第 1 页' }));
  const retry = await screen.findByRole('button', { name: '重试加载' });
  expect(loadPage).toHaveBeenCalledTimes(1);
  fireEvent.click(retry);
  await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:fresh'));
  expect(releasePage).toHaveBeenCalledWith(0);
  expect(loadPage).toHaveBeenCalledTimes(2);
});

it('keeps the original when a replacement fails to decode', async () => {
  setImageDecoderForTests(() => Promise.reject(new Error('bad rendition')));
  const view = render(<MemoryRouter><ReaderScreen archiveId="decode" title="Decode" pages={['blob:plain']} layout="single" /></MemoryRouter>);
  view.rerender(<MemoryRouter><ReaderScreen archiveId="decode" title="Decode" pages={['blob:plain']} layout="single" derivedPages={new Map([[0, 'blob:bad-derived']])} /></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:plain');
});

it('starts the desktop indicator in the corner before any image measurement', async () => {
  render(<MemoryRouter><ReaderScreen archiveId="placement" title="Placement" pages={['blob:plain']} layout="single" /></MemoryRouter>);
  expect(document.querySelector('.reader-page-indicator')).toHaveAttribute('data-placement', 'corner');
  await act(async () => {});
});

it('does not publish a page request that finishes after a rendition reload', async () => {
  let finish: ((url: string) => void) | undefined;
  const loadPage = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; })).mockResolvedValue('blob:new');
  const view = render(<MemoryRouter><ReaderScreen archiveId="race" title="Race" pages={['']} layout="single" loadPage={loadPage} /></MemoryRouter>);
  view.rerender(<MemoryRouter><ReaderScreen archiveId="race" title="Race" pages={['']} layout="single" loadPage={loadPage} reloadToken={1} /></MemoryRouter>);
  await act(async () => { finish?.('blob:old'); });
  await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:new'));
});

it('does not exhaust the original when the displayed derived predecessor fails while its successor decodes', async () => {
  let finish: (() => void) | undefined;
  setImageDecoderForTests(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<MemoryRouter><ReaderScreen archiveId="predecessor" title="Predecessor" pages={['blob:plain']} layout="single" derivedPages={new Map([[0, 'blob:derived-a']])} /></MemoryRouter>);
  view.rerender(<MemoryRouter><ReaderScreen archiveId="predecessor" title="Predecessor" pages={['blob:plain']} layout="single" derivedPages={new Map([[0, 'blob:derived-b']])} /></MemoryRouter>);
  fireEvent.error(screen.getByRole('img', { name: '第 1 页' }));
  expect(screen.queryByRole('button', { name: '重试加载' })).not.toBeInTheDocument();
  await act(async () => { finish?.(); });
  expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:derived-b');
});

it('offers original retry when a broken derived page cannot recover to the original', async () => {
  setImageDecoderForTests(() => Promise.reject(new Error('original cannot decode')));
  const loadPage = vi.fn().mockResolvedValue('blob:fresh-original');
  const releasePage = vi.fn();
  render(<MemoryRouter><ReaderScreen archiveId="recovery" title="Recovery" pages={['blob:plain']} layout="single" derivedPages={new Map([[0, 'blob:derived']])} loadPage={loadPage} releasePage={releasePage} /></MemoryRouter>);
  fireEvent.error(screen.getByRole('img', { name: '第 1 页' }));
  const retry = await screen.findByRole('button', { name: '重试加载' });
  fireEvent.click(retry);
  await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:fresh-original'));
  expect(releasePage).toHaveBeenCalledWith(0);
});


it('promotes the actual decoded candidate node in both directions without changing the healthy node src', async () => {
  let finish: (() => void) | undefined;
  setImageDecoderForTests(() => new Promise<void>((resolve) => { finish = resolve; }));
  const props = { archiveId: 'nodes', title: 'Nodes', pages: ['blob:plain'], layout: 'single' as const };
  const displayed = vi.fn((_index: number, url: string) => {
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', url);
    expect(document.querySelector(`img[src="${url}"]`)).not.toHaveClass('is-candidate');
  });
  const view = render(<MemoryRouter><ReaderScreen {...props} onDerivedDisplayed={displayed} /></MemoryRouter>);
  const original = screen.getByRole('img', { name: '第 1 页' });
  view.rerender(<MemoryRouter><ReaderScreen {...props} derivedPages={new Map([[0, 'blob:derived']])} onDerivedDisplayed={displayed} /></MemoryRouter>);
  const candidate = document.querySelector('img[src="blob:derived"]');
  expect(candidate).not.toBeNull();
  expect(original).toHaveAttribute('src', 'blob:plain');
  expect(displayed).not.toHaveBeenCalled();
  await act(async () => { finish?.(); });
  expect(screen.getByRole('img', { name: '第 1 页' })).toBe(candidate);
  expect(displayed).toHaveBeenCalledWith(0, 'blob:derived');
  view.rerender(<MemoryRouter><ReaderScreen {...props} onDerivedDisplayed={displayed} /></MemoryRouter>);
  const plainCandidate = document.querySelector('img[src="blob:plain"]');
  expect(candidate).toHaveAttribute('src', 'blob:derived');
  await act(async () => { finish?.(); });
  expect(screen.getByRole('img', { name: '第 1 页' })).toBe(plainCandidate);
});

it('keeps indicator placement when continuous layout hides it', async () => {
  render(<MemoryRouter><ReaderScreen archiveId="hidden-placement" title="Hidden" pages={['blob:plain']} layout="webtoon" /></MemoryRouter>);
  expect(document.querySelector('.reader-page-indicator')).toHaveAttribute('data-placement', 'corner');
  expect(document.querySelector('.reader-page-indicator')).toHaveAttribute('data-visible', 'false');
  await act(async () => {});
});


it('ignores an obsolete decoded candidate and keeps a healthy image when the newest candidate fails', async () => {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  setImageDecoderForTests((url) => new Promise<void>((resolve, reject) => { pending.set(url, { resolve, reject }); }));
  const props = { archiveId: 'candidate-race', title: 'Race', pages: ['blob:plain'], layout: 'single' as const };
  const displayed = vi.fn();
  const view = render(<MemoryRouter><ReaderScreen {...props} onDerivedDisplayed={displayed} /></MemoryRouter>);
  const original = screen.getByRole('img', { name: '第 1 页' });
  view.rerender(<MemoryRouter><ReaderScreen {...props} derivedPages={new Map([[0, 'blob:a']])} onDerivedDisplayed={displayed} /></MemoryRouter>);
  view.rerender(<MemoryRouter><ReaderScreen {...props} derivedPages={new Map([[0, 'blob:b']])} onDerivedDisplayed={displayed} /></MemoryRouter>);
  await act(async () => { pending.get('blob:a')?.resolve(); });
  expect(screen.getByRole('img', { name: '第 1 页' })).toBe(original);
  expect(displayed).not.toHaveBeenCalled();
  await act(async () => { pending.get('blob:b')?.reject(new Error('broken')); });
  expect(screen.getByRole('img', { name: '第 1 页' })).toBe(original);
  expect(screen.queryByRole('button', { name: '重试加载' })).not.toBeInTheDocument();
});

it('keeps a neighbour enhancement decoded through the gesture and promotes that same image after it settles', async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  const decode = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  setImageDecoderForTests(decode);
  const view = (derivedPages?: ReadonlyMap<number, string>) => (
    <MemoryRouter><ReaderScreen archiveId="warm-neighbour" title="Warm neighbour" pages={['blob:first', 'blob:next']} layout="single" derivedPages={derivedPages} /></MemoryRouter>
  );
  const { container, rerender } = render(view());
  rerender(view(new Map([[1, 'blob:enhanced-next']])));
  const candidate = container.querySelector('img[src="blob:enhanced-next"]');
  expect(candidate).not.toBeNull();
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  fireEvent.touchStart(reader, { touches: [{ clientX: 150, clientY: 300 }] });
  await act(async () => { finish?.(); });
  expect(candidate).toHaveClass('is-candidate');
  expect(candidate).toBeInTheDocument();
  fireEvent.touchEnd(reader, { touches: [], changedTouches: [{ clientX: 150, clientY: 300 }] });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(candidate).not.toHaveClass('is-candidate');
  expect(candidate).toBeInTheDocument();
  expect(decode).toHaveBeenCalledTimes(1);
});
