import { act, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ImageCacheIdentity } from '../../src/domain/cache';
import type { ImageHandle } from '../../src/lib/unifiedImageCache';

const cache = vi.hoisted(() => { vi.resetModules(); return { load: vi.fn(), release: vi.fn() }; });
vi.mock('../../src/lib/nativeImageCache', () => ({ getNativeImageCache: () => cache }));
import { ArchiveOverviewDialog } from '../../src/components/ArchiveOverviewDialog';
import { RetainedPage } from '../../src/app/RetainedPage';

describe('archive overview image lifetimes', () => {
  it('closes on retained-page deactivation and releases loaded and late preview handles', async () => {
    cache.load.mockReset(); cache.release.mockClear();
    let finishPreview: ((handle: ImageHandle) => void) | undefined;
    cache.load.mockImplementation((identity: ImageCacheIdentity) => identity.rendition === 'cover'
      ? Promise.resolve({ key: 'cover', url: 'cover', bytes: 1 })
      : new Promise<ImageHandle>((finish) => { finishPreview = finish; }));
    const onClose = vi.fn();
    function Owner({ active }: { active: boolean }) {
      const [open, setOpen] = useState(true);
      return <RetainedPage active={active}>{open && <ArchiveOverviewDialog scopeId="scope" serverId="s"
        archive={{ serverId: 's', archiveId: 'a', title: 'A', pageCount: 1, updatedAt: 'now' }}
        onClose={() => { onClose(); setOpen(false); }} />}</RetainedPage>;
    }
    const view = render(<Owner active />);
    await act(async () => {});
    expect(finishPreview).toBeDefined();
    view.rerender(<Owner active={false} />);
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cache.release).toHaveBeenCalledWith(expect.objectContaining({ key: 'cover' }));
    await act(async () => { finishPreview!({ key: 'late', url: 'late', bytes: 1 }); });
    expect(cache.release).toHaveBeenCalledWith(expect.objectContaining({ key: 'late' }));
    view.rerender(<Owner active />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('drops stale images when switching archives and loads previews for the new archive', async () => {
    const pending: Array<{ identity: ImageCacheIdentity; finish: (handle: ImageHandle) => void }> = [];
    cache.load.mockImplementation((identity: ImageCacheIdentity) => new Promise<ImageHandle>((finish) => { pending.push({ identity, finish }); }));
    const props = { scopeId: 'scope', serverId: 'server', onClose: vi.fn() };
    const archive = { serverId: 'server', archiveId: 'a', title: 'First', pageCount: 1, updatedAt: 'now' };
    const view = render(<ArchiveOverviewDialog {...props} archive={archive} />);
    view.rerender(<ArchiveOverviewDialog {...props} archive={{ ...archive, archiveId: 'b', title: 'Second' }} />);
    const complete = async (id: string) => {
      await act(async () => {
        for (const request of pending.filter((item) => item.identity.archiveId === id)) {
          const url = `${id}-${request.identity.rendition}`;
          request.finish({ key: url, url, bytes: 1 });
        }
      });
    };
    await complete('b');
    expect(screen.getByRole('figure', { name: '第 1 页' }).querySelector('img')).toHaveAttribute('src', 'b-page-thumbnail');
    await complete('a');
    expect(document.querySelector('.reader-overview-cover')).toHaveAttribute('src', 'b-cover');
    expect(cache.release).toHaveBeenCalledWith(expect.objectContaining({ url: 'a-cover' }));
  });

  it('releases image handles from discarded StrictMode effects', async () => {
    cache.load.mockReset(); cache.release.mockClear();
    const pending: Array<(handle: ImageHandle) => void> = [];
    cache.load.mockImplementation(() => new Promise<ImageHandle>((finish) => { pending.push(finish); }));
    const view = render(<StrictMode><ArchiveOverviewDialog scopeId="scope" serverId="s" archive={{ serverId: 's', archiveId: 'a', title: 'A', pageCount: 1, updatedAt: 'now' }} onClose={vi.fn()} /></StrictMode>);
    await act(async () => { pending.forEach((finish, index) => finish({ key: String(index), url: `image-${index}`, bytes: 1 })); });
    expect(cache.release.mock.calls.length).toBeGreaterThan(0);
    view.unmount();
    expect(cache.release).toHaveBeenCalledTimes(pending.length);
  });
});
