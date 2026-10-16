import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetainedPage } from '../../src/app/RetainedPage';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { TextInputDialog } from '../../src/components/TextInputDialog';
import { ArchiveDeletionConfirmation } from '../../src/components/ArchiveDeleteDialog';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';

afterEach(resetInvokeAdapterForTests);

describe('dialogs owned by a retained page', () => {
  it.each(['confirm', 'text', 'delete'] as const)('retires a busy %s dialog without letting its completion close a new one', async (kind) => {
    setInvokeAdapterForTests(async (command) => command === 'load_preferences'
      ? { ok: true, value: DEFAULT_PREFERENCES } : { ok: true, value: [] });
    let finish!: () => void;
    const confirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const close = vi.fn();
    function Owner({ active }: { active: boolean }) {
      const [open, setOpen] = useState(true);
      const dismiss = () => { close(); setOpen(false); };
      return <><button onClick={() => setOpen(true)}>Open dialog</button><RetainedPage active={active}>
        {open && (kind === 'confirm'
          ? <ConfirmDialog title="Confirm" description="Description" onConfirm={confirm} onClose={dismiss} />
          : kind === 'text'
            ? <TextInputDialog open title="Text" label="Name" defaultValue="Draft" onConfirm={confirm} onOpenChange={(next) => { if (!next) dismiss(); }} />
            : <ArchiveDeletionConfirmation description="Delete archive" onConfirm={confirm} onClose={dismiss} />)}
      </RetainedPage></>;
    }
    const view = render(<Owner active />);
    const label = kind === 'confirm' ? '确认' : kind === 'text' ? '确定' : '确认删除';
    await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(confirm).toHaveBeenCalledTimes(1);
    view.rerender(<Owner active={false} />);
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
    expect(close).toHaveBeenCalledTimes(1);
    view.rerender(<Owner active />);
    fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
    await act(async () => { finish(); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: label })).toBeEnabled();
  });
});
