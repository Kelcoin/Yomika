import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useArchiveSelection } from '../../src/components/useArchiveSelection';
import { ToastProvider } from '../../src/components/Toast';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

function Selection() {
  const [rows, setRows] = useState(['a', 'b'].map((archiveId) => ({ archiveId, serverId: 's', title: archiveId, pageCount: 1, updatedAt: 'now' })));
  const selection = useArchiveSelection({ archives: rows, scopeId: 'scope', onRemoved: (ids) => setRows((current) => current.filter((row) => !ids.includes(row.archiveId))) });
  return <>
    {rows.map((row) => <span key={row.archiveId}>Archive {row.archiveId}</span>)}
    <button onClick={() => selection.props.onSelectionChange(new Set(['a', 'b']))}>Select both</button>
    {selection.actions}{selection.dialogs}
  </>;
}

function ScopedSelection({ serverId, onRemoved }: { serverId: string; onRemoved: (ids: string[]) => void }) {
  const selection = useArchiveSelection({
    archives: [{ archiveId: 'shared', serverId, title: serverId, pageCount: 1, updatedAt: 'now' }],
    scopeId: serverId, serverId, membership: { list: 'reading', label: '待看', present: true }, onRemoved,
  });
  return <>
    <button onClick={() => { selection.props.onSelectionModeChange(true); selection.props.onSelectionChange(new Set(['shared'])); }}>Select archive</button>
    <span>Selection {selection.props.selectedArchiveIds.size}</span>
    {selection.actions}{selection.dialogs}
  </>;
}

describe('archive selection deletion', () => {
  it('drops an old selection and deletion confirmation when changing server scope', async () => {
    setInvokeAdapterForTests(async command => command === 'load_preferences'
      ? { ok: true, value: DEFAULT_PREFERENCES } : { ok: true, value: [] });
    const user = userEvent.setup();
    const onRemoved = vi.fn();
    const view = render(<ScopedSelection serverId="A" onRemoved={onRemoved} />);
    await user.click(screen.getByRole('button', { name: 'Select archive' }));
    await user.click(screen.getByRole('button', { name: '删除所选' }));
    await screen.findByRole('dialog');
    view.rerender(<ScopedSelection serverId="B" onRemoved={onRemoved} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Selection 0')).toBeInTheDocument();
  });

  it('does not remove B rows or clear a new B selection after an old A membership write', async () => {
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async command => {
      if (command === 'set_reading_list') return new Promise(resolve => { finish = resolve; });
      return { ok: true, value: [] };
    });
    const user = userEvent.setup();
    const onRemoved = vi.fn();
    const view = render(<ScopedSelection serverId="A" onRemoved={onRemoved} />);
    await user.click(screen.getByRole('button', { name: 'Select archive' }));
    await user.click(screen.getByRole('button', { name: '移出待看' }));
    await waitFor(() => expect(finish).toBeDefined());
    view.rerender(<ScopedSelection serverId="B" onRemoved={onRemoved} />);
    await user.click(screen.getByRole('button', { name: 'Select archive' }));
    await act(async () => finish({ ok: true, value: { scopeId: 'A', archiveId: 'shared', addedAt: 'now', updatedAt: 'now', deviceId: 'test', revision: 1, deleted: true } }));
    expect(onRemoved).not.toHaveBeenCalled();
    expect(screen.getByText('Selection 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '移出待看' })).toBeEnabled();
  });

  it('removes completed deletions even if a later archive fails and retries only the remaining archive', async () => {
    const deleted: string[] = [];
    let failed = false;
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'delete_archive') {
        const id = (args as { archiveId: string }).archiveId;
        deleted.push(id);
        if (id === 'b' && !failed) {
          failed = true;
          return { ok: false, error: { code: 'LOCAL_DATABASE', message: 'B failed', retryable: true } };
        }
        return { ok: true, value: null };
      }
      throw new Error(command);
    });
    const user = userEvent.setup();
    render(<ToastProvider><Selection /></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'Select both' }));
    await user.click(screen.getByRole('button', { name: '删除所选' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(await screen.findByText('B failed')).toBeInTheDocument();
    expect(screen.queryByText('Archive a')).not.toBeInTheDocument();
    expect(screen.getByText('Archive b')).toBeInTheDocument();
    expect(screen.getByText('将永久删除选中的 1 个档案，此操作不可撤销。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(screen.queryByText('Archive b')).not.toBeInTheDocument());
    expect(deleted).toEqual(['a', 'b', 'b']);
  });
});
