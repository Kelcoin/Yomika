import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import { ArchiveContextMenu } from '../../src/components/ArchiveContextMenu';
import { LibraryWorkspace } from '../../src/components/LibraryWorkspace';
import { useArchiveContextMenu } from '../../src/components/useArchiveContextMenu';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';
import type { ArchiveRecord } from '../../src/domain/library';
import type { ImageHandle } from '../../src/lib/unifiedImageCache';

/** 缺陷 1：长按档案卡片呼出菜单偶发闪烁。
 *
 * Android 的长按既会走 450ms 的 hold 回调，也会再送一个合成的 `contextmenu`
 * （`src/lib/longPressMenu.ts` 的头部注释记的正是这件事），于是同一张卡片会
 * `open()` 两次。旧实现里每次 `open()` 都无条件清掉 membership，`progress.ready`
 * 跟着掉回 false，而菜单恰恰挂在 `progress.ready` 上：菜单先被拆下来，等下一轮
 * IPC 回来才重建——用户看到的就是那一下闪烁。
 *
 * 判据钉的是机制本身：同一张卡片再次呼出，(1) 菜单不许被拆掉，(2) 不许再发一次
 * 进度读取。两条在旧实现下都会转红。 */
function MenuHarness() {
  const menu = useArchiveContextMenu();
  return <><button onClick={() => menu.open({ serverId: 'server', archiveId: 'archive', title: 'Test', pageCount: 10, updatedAt: '' }, { x: 20, y: 20 })}>Open</button>{menu.menu}</>;
}

afterEach(() => vi.restoreAllMocks());

it('keeps the open menu and skips a second progress read when the same card opens again', async () => {
  vi.spyOn(NativeLibraryRepository.prototype, 'listServers').mockResolvedValue({ ok: true, value: [{ id: 'server', scopeId: 'scope', name: 'Test', baseUrl: 'https://example.com', enabled: true }] });
  vi.spyOn(NativeLibraryRepository.prototype, 'archiveMembership').mockResolvedValue({ ok: true, value: { reading: false, favorites: false } });
  vi.spyOn(NativeLibraryRepository.prototype, 'readFavoritesCategory').mockResolvedValue({ ok: true, value: null });
  const reads: Array<(value: Awaited<ReturnType<NativeLibraryRepository['loadReadingStatus']>>) => void> = [];
  vi.spyOn(NativeLibraryRepository.prototype, 'loadReadingStatus').mockImplementation(() => new Promise((done) => { reads.push(done); }));

  render(<MemoryRouter><MenuHarness /></MemoryRouter>);
  await act(async () => { fireEvent.click(screen.getByText('Open')); });
  await act(async () => { reads[0]?.({ ok: true, value: { progress: null, hasHistory: false } }); });
  expect(screen.getByRole('menu')).toBeInTheDocument();

  await act(async () => { fireEvent.click(screen.getByText('Open')); });
  // 旧实现：membership 被清掉 → progress.ready 掉回 false → 菜单已经不在文档里了。
  expect(screen.getByRole('menu')).toBeInTheDocument();
  // 旧实现：同一张卡片又走了一遍 listServers/loadProgress，这一条也会红。
  expect(reads).toHaveLength(1);
});

/** 缺陷 2：进入档案库时封面经常会重新加载一下（骨架→图那一闪）。
 *
 * 虚拟行滚出窗口就会卸载，重新挂载时 `LazyThumbnail` 从 `src === undefined` 起步，
 * 于是哪怕共享缓存里那张封面还活着（`retain: true`，远没到 96MiB/256 条上限），
 * 第一帧也只能画骨架。判据让加载永不解析：出现在首批行里的任何 `<img>` 都只可能
 * 来自同步种子 `peek`。 */
const archiveList: ArchiveRecord[] = Array.from({ length: 30 }, (_, index) => ({
  serverId: 'local',
  archiveId: `archive-${index}`,
  title: `Archive ${index}`,
  pageCount: index + 1,
  updatedAt: '2026-08-26T00:00:00.000Z',
}));

function renderList(props: Partial<React.ComponentProps<typeof LibraryWorkspace>>) {
  return render(<MemoryRouter><LibraryWorkspace archives={archiveList} showDetail={false} {...props} /></MemoryRouter>);
}

it('paints a remounted row cover from the warm cache instead of its skeleton', async () => {
  const never = () => new Promise<ImageHandle | undefined>(() => {});
  const { container } = renderList({ onLoadThumbnail: never, peekThumbnail: () => 'blob:warm-cover' });
  await waitFor(() => expect(container.querySelector('.archive-row-thumb')).not.toBeNull());
  const thumb = container.querySelector('.archive-row-thumb')!;
  // 旧实现：这一帧是 `archive-row-thumb is-skeleton` + 占位 <span>。
  expect(thumb.className).not.toContain('is-skeleton');
  expect(thumb.querySelector('img')?.getAttribute('src')).toBe('blob:warm-cover');
});

it('still starts a cold row on its skeleton', async () => {
  const never = () => new Promise<ImageHandle | undefined>(() => {});
  const { container } = renderList({ onLoadThumbnail: never, peekThumbnail: () => undefined });
  await waitFor(() => expect(container.querySelector('.archive-row-thumb')).not.toBeNull());
  expect(container.querySelector('.archive-row-thumb')!.className).toContain('is-skeleton');
  expect(container.querySelector('.archive-row-thumb img')).toBeNull();
});


it('opens a card context menu without changing the page scroll lock', async () => {
  render(<ArchiveContextMenu target={{ archive: archiveList[0]!, x: 20, y: 20 }} onClose={() => {}} onRead={() => {}} onReadIncognito={() => {}} />);
  await screen.findByRole('menu');
  expect(document.body).not.toHaveAttribute('data-scroll-locked');
  expect(document.body.style.pointerEvents).not.toBe('none');
});
