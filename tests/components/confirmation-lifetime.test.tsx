import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';

describe('confirmation operation lifetime', () => {
  it('runs one operation for batched clicks and allows retry after failure', async () => {
    let fail!: (error: Error) => void;
    const confirm = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValue(undefined);
    const close = vi.fn();
    render(<ConfirmDialog title="Clear records" description="Remove selected records" onConfirm={confirm} onClose={close} />);
    const button = screen.getByRole('button', { name: '确认' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error('unavailable')));
    expect(close).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
    await act(async () => fireEvent.click(button));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not call close after the confirmation was unmounted', async () => {
    let finish!: () => void;
    const close = vi.fn();
    const view = render(<ConfirmDialog title="Clear records" description="Remove selected records" onConfirm={() => new Promise<void>(resolve => { finish = resolve; })} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    view.unmount();
    await act(async () => finish());
    expect(close).not.toHaveBeenCalled();
  });
});
