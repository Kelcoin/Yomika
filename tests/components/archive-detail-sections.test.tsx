import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ArchiveDetailCover, ArchiveDetailFacts, ArchiveDetailTagSection, useArchiveCover } from '../../src/components/ArchiveDetailSections';
import { getNativeImageCache } from '../../src/lib/nativeImageCache';
import { RetainedPage } from '../../src/app/RetainedPage';

/** 档案详情页与本地档案详情面板共用的那几块：事实网格、封面（含大图预览）、标签墙。
 * 抽出来的边界就在这里，页面级测试不一定会走到。 */
describe('archive detail sections', () => {
  it('returns a full preview into a cropped cover without distorting the artwork', () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'animate');
    Object.defineProperty(HTMLImageElement.prototype, 'animate', { configurable: true, value: animate });
    const bounds = vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLImageElement) {
      return this.parentElement?.classList.contains('archive-detail-cover-trigger')
        ? new DOMRect(20, 30, 100, 150) : new DOMRect(200, 100, 600, 600);
    });
    try {
      render(<ArchiveDetailCover title="Crop" cover="blob:cropped" />);
      (screen.getByAltText('Crop 封面') as HTMLElement).style.borderTopLeftRadius = '12px';
      fireEvent.click(screen.getByRole('button', { name: '查看Crop大图' }));
      const frames = animate.mock.calls as unknown as [Keyframe[], KeyframeAnimationOptions][];
      expect(frames[0]?.[0][0]).toEqual({ transform: 'translate(-430px, -295px) scale(0.25, 0.25)', clipPath: 'inset(0px 100px round 48px)' });
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(frames[1]?.[0][1]).toEqual(frames[0]?.[0][0]);
    } finally {
      bounds.mockRestore();
      if (original) Object.defineProperty(HTMLImageElement.prototype, 'animate', original);
      else delete (HTMLImageElement.prototype as { animate?: unknown }).animate;
    }
  });
  it('closes a cover preview when the retained page hides', async () => {
    const user = userEvent.setup();
    const content = <ArchiveDetailCover title="A" cover="blob:a" />;
    const view = render(<RetainedPage active>{content}</RetainedPage>);
    await user.click(screen.getByRole('button', { name: '查看A大图' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.rerender(<RetainedPage active={false}>{content}</RetainedPage>);
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
    view.rerender(<RetainedPage active>{content}</RetainedPage>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('contains preview keyboard focus and returns it to the cover trigger', async () => {
    const user = userEvent.setup();
    render(<><ArchiveDetailCover title="A" cover="blob:a" /><button>Outside action</button></>);
    const trigger = screen.getByRole('button', { name: '查看A大图' });
    await user.click(trigger);
    const preview = screen.getByRole('dialog');
    expect(preview).toHaveFocus();
    await user.tab();
    expect(preview).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('does not expose the previous archive cover while the next cover loads', async () => {
    const cache = getNativeImageCache();
    const first = { key: 'cover-a', url: 'blob:cover-a', bytes: 1 };
    const load = vi.spyOn(cache, 'load').mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(() => {}));
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    try {
      const hook = renderHook(({ archiveId }) => useArchiveCover({ scopeId: 'scope-a', serverId: 'server-a', archiveId }), { initialProps: { archiveId: 'a' } });
      await waitFor(() => expect(hook.result.current.cover).toBe('blob:cover-a'));
      hook.rerender({ archiveId: 'b' });
      expect(hook.result.current.cover).toBeUndefined();
      expect(hook.result.current.loading).toBe(true);
      expect(release).toHaveBeenCalledWith(first);
      hook.unmount();
    } finally { load.mockRestore(); release.mockRestore(); }
  });

  it('closes an open preview when the archive cover changes', async () => {
    const user = userEvent.setup();
    const view = render(<ArchiveDetailCover title="A" cover="blob:a" />);
    await user.click(screen.getByRole('button', { name: '查看A大图' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.rerender(<ArchiveDetailCover title="B" cover="blob:b" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('draws one glyph per fact and the value beside it', () => {
    render(<ArchiveDetailFacts facts={[
      { kind: 'pages', label: '页数', value: '42 页' },
      { kind: 'path', label: '路径', value: 'E:\\Downloads\\a.cbz' },
    ]} />);

    expect(screen.getByText('42 页')).toBeInTheDocument();
    expect(screen.getByText('E:\\Downloads\\a.cbz')).toBeInTheDocument();
    // 路径那一格要占满整行（CSS 按 data-fact 认），所以属性得在。
    expect(document.querySelector('.archive-detail-facts > div[data-fact="path"]')).not.toBeNull();
    expect(document.querySelectorAll('.archive-detail-facts svg')).toHaveLength(2);
  });

  it('opens the cover preview on click and closes it with Escape', async () => {
    const user = userEvent.setup();
    render(<ArchiveDetailCover title="测试档案" cover="blob:cover" />);

    expect(document.querySelectorAll('.archive-cover-preview')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '查看测试档案大图' }));
    expect(document.querySelectorAll('.archive-cover-preview')).toHaveLength(1);

    // 预览层归这个组件管，Esc 也归它关。
    await user.keyboard('{Escape}');
    expect(document.querySelector('.archive-cover-preview')).toHaveClass('is-closing');
    await waitFor(() => expect(document.querySelectorAll('.archive-cover-preview')).toHaveLength(0));
  });

  it('uses the wide layout only for the currently loaded landscape cover', () => {
    const view = render(<ArchiveDetailCover title="A" cover="blob:wide" />);
    const image = screen.getByAltText('A 封面');
    Object.defineProperties(image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 900 } });
    fireEvent.load(image);
    expect(document.querySelector('.archive-detail-route-cover')).toHaveClass('is-wide');
    view.rerender(<ArchiveDetailCover title="B" cover="blob:portrait" />);
    expect(document.querySelector('.archive-detail-route-cover')).not.toHaveClass('is-wide');
  });

  it('expands from the cover bounds and animates back before removing the overlay', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn();
    const animate = vi.fn((_frames: Keyframe[], _options?: KeyframeAnimationOptions) => ({ cancel }));
    const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'animate');
    Object.defineProperty(HTMLImageElement.prototype, 'animate', { configurable: true, value: animate });
    const bounds = vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLImageElement) {
      return this.parentElement?.classList.contains('archive-detail-cover-trigger')
        ? new DOMRect(20, 30, 100, 150) : new DOMRect(200, 100, 400, 600);
    });
    try {
      render(<ArchiveDetailCover title="A" cover="blob:a" />);
      await user.click(screen.getByRole('button', { name: '查看A大图' }));
      expect(animate.mock.calls[0]?.[0]).toEqual([
        { transform: 'translate(-330px, -295px) scale(0.25, 0.25)', clipPath: 'inset(0px 0px round 0px)' }, { transform: 'none', clipPath: 'inset(0px 0px round 0px)' },
      ]);
      await user.keyboard('{Escape}');
      expect(animate).toHaveBeenCalledTimes(2);
      expect(animate.mock.calls[1]?.[0]?.[1]).toEqual({ transform: 'translate(-330px, -295px) scale(0.25, 0.25)', clipPath: 'inset(0px 0px round 0px)' });
      expect(cancel).toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toHaveClass('is-closing');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    } finally {
      bounds.mockRestore();
      if (original) Object.defineProperty(HTMLImageElement.prototype, 'animate', original);
      else delete (HTMLImageElement.prototype as { animate?: unknown }).animate;
    }
  });

  it('renders a placeholder instead of a cover when there is none', () => {
    render(<ArchiveDetailCover title="测试档案" loading />);
    expect(document.querySelector('.archive-detail-cover-placeholder.is-skeleton')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '查看测试档案大图' })).not.toBeInTheDocument();
  });

  it('filters the list through onSelect instead of linking to the library', async () => {
    const user = userEvent.setup();
    const selected: string[] = [];
    render(<ArchiveDetailTagSection
      groups={[{ namespace: 'female', label: '女性', values: [{ label: '眼镜', query: 'female:glasses$' }] }]}
      onSelect={(tag) => selected.push(tag.query)}
    />);

    await user.click(screen.getByRole('button', { name: '筛选 眼镜' }));
    expect(selected).toEqual(['female:glasses$']);
    // 本地档案页不该把标签点成档案库的链接。
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('links each tag to the library when no onSelect is given', () => {
    // TagSearchLink 读 search params（多服务器时要把 server 带上），所以要个 Router。
    render(<MemoryRouter><ArchiveDetailTagSection
      groups={[{ namespace: 'female', label: '女性', values: [{ label: '眼镜', query: 'female:glasses$' }] }]}
    /></MemoryRouter>);

    expect(screen.getByRole('link', { name: '搜索标签 眼镜' })).toHaveAttribute('href', expect.stringContaining('q=female%3Aglasses%24'));
  });
});
