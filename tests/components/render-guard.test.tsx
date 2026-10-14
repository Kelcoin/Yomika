import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RenderGuard } from '../../src/components/RenderGuard';
import { flushErrorLog, setErrorLogSinkForTests, type ErrorLogRecord } from '../../src/lib/errorLog';

function Boom(): ReactNode {
  throw new Error('这一块渲染炸了');
}

/**
 * 判据要证明的是「渲染期抛错不再是一片空白」：窗口背景是透明的（tauri.conf 的
 * `#0B0B0F00`），没有这一层时 React 会把整棵树卸载掉，用户看到的是「窗口还在、里面什么
 * 都没有」——也就是 2026-10-14 报的「窗口消失」。同时它必须留下一条日志，否则下一次还是
 * 只能靠猜。
 *
 * 变异检查：把 `RenderGuard` 换回 `props.children`（即去掉这一层），第一条用例立刻转红
 * （拿不到 `role="alert"`）；把 `componentDidCatch` 里的 `logError` 删掉，第二条断言转红。
 */
describe('渲染期抛错', () => {
  const records: ErrorLogRecord[] = [];
  let restoreConsole: () => void;

  beforeEach(() => {
    records.length = 0;
    setErrorLogSinkForTests(async (batch) => {
      records.push(...batch);
      return true;
    });
    // React 自己也会把捕获到的错误打一行 console.error：测试输出里不需要它（我们不是在
    // 断言 React 的行为），静音掉以免淹没有效信息。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    restoreConsole = () => {
      spy.mockRestore();
    };
  });

  afterEach(() => {
    restoreConsole();
    setErrorLogSinkForTests(undefined);
  });

  it('换成一块看得见的说明，并把这次错误记进日志', async () => {
    render(
      <RenderGuard>
        <Boom />
      </RenderGuard>,
    );
    const fallback = await screen.findByRole('alert');
    expect(fallback.textContent).toContain('界面这一块渲染出错了');
    expect(fallback.textContent).toContain('这一块渲染炸了');
    await flushErrorLog();
    expect(records.map((item) => item.source)).toContain('render');
    expect(records.map((item) => item.message)).toContain('界面渲染出错，这一块被换成了说明');
    expect(records.map((item) => item.detail ?? '').join('\n')).toContain('这一块渲染炸了');
  });

  it('没有错的时候原样渲染子树', () => {
    render(
      <RenderGuard>
        <p>一切正常</p>
      </RenderGuard>,
    );
    expect(screen.getByText('一切正常')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
