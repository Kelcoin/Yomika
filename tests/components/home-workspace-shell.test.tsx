import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetArchiveExistenceForTests } from '../../src/lib/archiveExistence';
import { writeRouteCache } from '../../src/lib/routeCache';

afterEach(() => {
  resetInvokeAdapterForTests();
  resetArchiveExistenceForTests();
  vi.clearAllMocks();
});

/** 首页与档案库共用同一种工作区容器：两侧的空隙来自面板自己的 16px，而不是
 * `.workspace` 那个 1320px 居中盒子加 48px 内边距。 */
function renderHome() {
  setInvokeAdapterForTests(vi.fn(async (command: string) => {
    if (command === 'list_servers' || command === 'list_tasks') return { ok: true, value: [] };
    if (command === 'cache_stats') return { ok: true, value: { bytes: 0, entries: 0 } };
    if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
    return { ok: true, value: [] };
  }));
  return render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
}

/** 首页那一页的保留面板。`App` 自己还包着一层 `.route-cache-panel`，而它同样是
 * `.workspace-home` 的祖先，所以取最里面那个（文档顺序里最后出现的一个）。 */
function homePanel(): Element | null {
  const panels = [...document.querySelectorAll('.route-cache-panel')].filter((panel) => panel.querySelector('.workspace-home'));
  return panels[panels.length - 1] ?? null;
}

describe('home workspace container', () => {
  it('recovers from malformed cached shelves instead of showing a render error', async () => {
    writeRouteCache('home:shelves', { servers: { ok: true, value: [] }, history: {}, readingList: [], archives: [], randomArchives: [] });
    renderHome();
    await screen.findByRole('heading', { name: '添加你的 LANraragi' });
  });

  it('renders the home page in the same list + detail shell as the library', async () => {
    renderHome();
    await screen.findByRole('heading', { name: '添加你的 LANraragi' });
    const shell = document.querySelector('.library-shell');
    expect(shell).not.toBeNull();
    // 列表那一栏里装的还是首页自己那三排，没有被换成别的页面。
    expect(shell?.querySelector('.library-shell-list .workspace-home')).not.toBeNull();
    expect(shell?.className).not.toContain('has-detail');
  });

  it('keeps the home page panel growing with its content, like the shelves', async () => {
    renderHome();
    await screen.findByRole('heading', { name: '添加你的 LANraragi' });
    const panel = homePanel();
    expect(panel).not.toBeNull();
    // `is-flow`（面板随内容长高）是契约：`design-system-contract.test.ts` 认这个字面量，
    // 因为 `height: 100%` 的钳制会把最后一排书架的尾巴困在面板外、滚不到。
    expect(panel?.className).toContain('is-flow');
  });

  it('does not take the overflow-hidden library workspace while its panel grows', async () => {
    renderHome();
    await screen.findByRole('heading', { name: '添加你的 LANraragi' });
    // `.workspace.is-library-workspace` 是 `overflow: hidden`：面板既然跟着内容长，
    // 超出一屏的部分就会被裁掉、滚不到（首页从前正是因此落在普通工作区）。
    // 首页的左右空隙因此由 shell.css 里 `:has(.workspace-home)` 那条规则放宽。
    // 反过来说，如果哪天这条面板不再 `is-flow`，首页就可以直接拿那个容器。
    expect(document.getElementById('main-content')?.className).not.toContain('is-library-workspace');
  });
});
