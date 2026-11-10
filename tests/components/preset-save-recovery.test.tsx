import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetRouteCacheForTests } from '../../src/lib/routeCache';

afterEach(() => { resetInvokeAdapterForTests(); resetRouteCacheForTests(); });

describe('preset save recovery', () => {
  it.each(['/library', '/downloads', '/to-read'])('retains the draft after a failed save on %s and waits for retry', async path => {
    const user = userEvent.setup();
    let saves = 0;
    let finish!: (value: unknown) => void;
    let savedInput: Record<string, unknown> = {};
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'server-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'search_archives_page' || command === 'list_archives_page') return { ok: true, value: { items: [], total: 0, hasMore: false } };
      if (command === 'save_search_preset') {
        savedInput = args?.input as Record<string, unknown>;
        if (++saves === 1) return { ok: false, error: { code: 'LOCAL_DATABASE', message: '预设保存暂时失败', retryable: true } };
        return new Promise(resolve => { finish = resolve; });
      }
      if (command.startsWith('list_') || command === 'find_missing_archives') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '检索预设' }));
    await user.click(screen.getByRole('menuitem', { name: '新增预设' }));
    const dialog = await screen.findByRole('dialog', { name: '存为预设' });
    const input = within(dialog).getByRole('textbox', { name: '预设名称' });
    await user.clear(input);
    await user.type(input, '保留这个名称');
    await user.click(within(dialog).getByRole('button', { name: '保存预设' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('预设保存暂时失败');
    expect(input).toHaveValue('保留这个名称');
    await user.click(within(dialog).getByRole('button', { name: '保存预设' }));
    expect(input).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '存为预设' })).toBeInTheDocument();
    expect(saves).toBe(2);
    await act(async () => finish({ ok: true, value: { ...savedInput, createdAt: '2026-10-15', updatedAt: '2026-10-15', deviceId: 'test', revision: 1, deleted: false } }));
    expect(screen.queryByRole('dialog', { name: '存为预设' })).not.toBeInTheDocument();
  });
});
