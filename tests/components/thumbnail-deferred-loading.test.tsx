import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => {
  // The shared setup preloads pages that import the cover component.
  vi.resetModules();
  return { load: vi.fn(), release: vi.fn() };
});
const visibility = vi.hoisted(() => ({ observe: vi.fn(), stop: vi.fn() }));
vi.mock('../../src/lib/nativeImageCache', () => ({ getNativeImageCache: () => cache }));
vi.mock('../../src/lib/sharedIntersectionObserver', () => ({ observeOnceInScroll: visibility.observe }));
import { ArchiveThumbMedia } from '../../src/components/ArchiveThumbnailCard';

it('animates a deferred cover only after its existing lazy-load boundary starts the request', async () => {
  const callbacks: Array<() => void> = [];
  visibility.observe.mockImplementation((_node: Element, start: () => void) => {
    callbacks.push(start);
    return visibility.stop;
  });
  cache.load.mockRejectedValue(new Error('offline'));
  const { container, rerender, unmount } = render(<ArchiveThumbMedia scopeId="s" serverId="server" archiveId="first" />);
  expect(container.querySelector('.archive-thumb-card-skeleton')).toHaveClass('is-deferred');
  expect(cache.load).not.toHaveBeenCalled();
  await act(async () => { callbacks[0]!(); });
  expect(cache.load).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '重新加载封面' })).toBeInTheDocument();
  rerender(<ArchiveThumbMedia scopeId="s" serverId="server" archiveId="second" />);
  expect(container.querySelector('.archive-thumb-card-skeleton')).toHaveClass('is-deferred');
  expect(visibility.stop).toHaveBeenCalledTimes(1);
  // Hold the second request to inspect the actual loading state.
  cache.load.mockReturnValue(new Promise(() => {}));
  act(() => { callbacks[1]!(); });
  expect(container.querySelector('.archive-thumb-card-skeleton')).not.toHaveClass('is-deferred');
  unmount();
  expect(visibility.stop).toHaveBeenCalledTimes(2);
});
