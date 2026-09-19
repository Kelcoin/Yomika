import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ArchiveDetailCover, ArchiveDetailFacts, ArchiveDetailTagSection } from '../../src/components/ArchiveDetailSections';

/** 档案详情页与本地档案详情面板共用的那几块：事实网格、封面（含大图预览）、标签墙。
 * 抽出来的边界就在这里，页面级测试不一定会走到。 */
describe('archive detail sections', () => {
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
    expect(document.querySelectorAll('.archive-cover-preview')).toHaveLength(0);
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
