import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LibraryWorkspace } from '../../src/components/LibraryWorkspace';

const archive = (id: string) => ({ serverId: 's', archiveId: id, title: `Archive ${id}`, pageCount: 1, updatedAt: 'now' });
const metadata = (id: string) => ({ archiveId: id, title: `Title ${id}`, filename: `${id}.zip`, tags: 'artist:sample', summary: '', extension: 'zip', progress: 0, pageCount: 1, lastReadTime: 0, size: 1 });

describe('inline metadata editor lifetime', () => {
  it('starts a fresh editor for B and keeps it open after the old A save completes', async () => {
    let finish!: (value: { ok: boolean }) => void;
    const save = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finish = resolve; }));
    const view = render(<MemoryRouter><LibraryWorkspace archives={[archive('a')]} metadata={metadata('a')} onUpdateMetadata={save} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '编辑元数据' }));
    fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: 'Unsaved A' } });
    fireEvent.submit(document.querySelector('form.metadata-form')!);
    view.rerender(<MemoryRouter><LibraryWorkspace archives={[archive('b')]} metadata={metadata('b')} onUpdateMetadata={save} /></MemoryRouter>);
    expect(screen.queryByRole('textbox', { name: '标题' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑元数据' }));
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('Title b');
    await act(async () => finish({ ok: true }));
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('Title b');
  });

  it('prevents duplicate submits, preserves the draft on rejection and permits retry', async () => {
    let fail!: (error: Error) => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValue({ ok: true });
    render(<MemoryRouter><LibraryWorkspace archives={[archive('a')]} metadata={metadata('a')} onUpdateMetadata={save} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '编辑元数据' }));
    fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: 'My draft' } });
    act(() => {
      fireEvent.submit(document.querySelector('form.metadata-form')!);
      fireEvent.submit(document.querySelector('form.metadata-form')!);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: '标题' })).toBeDisabled();
    await act(async () => fail(new Error('Save unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Save unavailable');
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('My draft');
    expect(screen.getByRole('textbox', { name: '标题' })).toBeEnabled();
    await act(async () => fireEvent.submit(document.querySelector('form.metadata-form')!));
    expect(screen.queryByRole('textbox', { name: '标题' })).not.toBeInTheDocument();
  });
});
