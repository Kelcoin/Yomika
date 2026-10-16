import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetadataEditRoute } from '../../src/components/MetadataEditRoute';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

const servers = { ok: true, value: [{ id: 's', scopeId: 's', name: 'Server', baseUrl: 'https://example.com' }] };
const metadata = (archiveId: string) => ({ ok: true, value: { archiveId, title: `Title ${archiveId}`, filename: `${archiveId}.zip`, tags: 'artist:sample', summary: 'Original summary', extension: 'zip', progress: 0, pageCount: 10, lastReadTime: 0, size: 100 } });

describe('metadata editor request lifetimes', () => {
  it('retries plugin discovery without replacing unsaved metadata', async () => {
    let reads = 0;
    let pluginReads = 0;
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return servers;
      if (command === 'load_archive_metadata') { reads++; return metadata('a'); }
      if (command === 'list_metadata_plugins') return ++pluginReads === 1
        ? { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '插件暂时未读出', retryable: true } }
        : { ok: true, value: [{ id: 'eh', name: 'E-Hentai' }] };
      return { ok: true, value: null };
    });
    render(<MemoryRouter><MetadataEditRoute archiveId="a" /></MemoryRouter>);
    const title = await screen.findByRole('textbox', { name: '标题' });
    fireEvent.change(title, { target: { value: 'My unsaved title' } });
    fireEvent.click(await screen.findByRole('button', { name: '重新读取插件' }));
    await screen.findByRole('button', { name: '执行插件' });
    expect(title).toHaveValue('My unsaved title');
    expect(reads).toBe(1);
  });

  it('serializes save submissions and does not unlock B when an old A save completes', async () => {
    let finishSave!: (value: unknown) => void;
    let finishPlugin!: (value: unknown) => void;
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_servers') return servers;
      if (command === 'load_archive_metadata') return metadata(String(args?.archiveId));
      if (command === 'list_metadata_plugins') return { ok: true, value: [{ id: 'eh', name: 'E-Hentai' }] };
      if (command === 'update_archive_metadata') return new Promise(resolve => { finishSave = resolve; });
      if (command === 'use_metadata_plugin') return new Promise(resolve => { finishPlugin = resolve; });
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    const view = render(<MemoryRouter><MetadataEditRoute archiveId="a" /></MemoryRouter>);
    await screen.findByRole('textbox', { name: '标题' });
    act(() => {
      fireEvent.submit(document.querySelector('form.metadata-edit-form')!);
      fireEvent.submit(document.querySelector('form.metadata-edit-form')!);
    });
    await waitFor(() => expect(finishSave).toBeDefined());
    expect(adapter.mock.calls.filter(([command]) => command === 'update_archive_metadata')).toHaveLength(1);
    view.rerender(<MemoryRouter><MetadataEditRoute archiveId="b" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('Title b'));
    fireEvent.click(await screen.findByRole('button', { name: '执行插件' }));
    expect(screen.getByRole('textbox', { name: '标题' })).toBeDisabled();
    await act(async () => finishSave({ ok: true, value: { operation: 'update_metadata', success: 1 } }));
    expect(screen.getByRole('textbox', { name: '标题' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存元数据' })).toBeDisabled();
    await act(async () => finishPlugin({ ok: true, value: { data: { title: 'Plugin for B' } } }));
    expect(screen.getByRole('textbox', { name: '标题' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('Plugin for B');
  });

  it('requires a successful initial read before exposing save and permits retry', async () => {
    let reads = 0;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return servers;
      if (command === 'load_archive_metadata') return ++reads === 1
        ? { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '原始元数据未读出', retryable: true } } : metadata('a');
      if (command === 'list_metadata_plugins') return { ok: true, value: [] };
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter><MetadataEditRoute archiveId="a" /></MemoryRouter>);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: '保存元数据' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试载入元数据' }));
    expect(await screen.findByRole('textbox', { name: '标题' })).toHaveValue('Title a');
    expect(screen.getByRole('textbox', { name: '简介' })).toHaveValue('Original summary');
    expect(adapter.mock.calls.some(([command]) => command === 'update_archive_metadata')).toBe(false);
  });

  it('does not wait for the optional plugin list before displaying editable metadata', async () => {
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return servers;
      if (command === 'load_archive_metadata') return metadata('a');
      if (command === 'list_metadata_plugins') return new Promise(resolve => { finish = resolve; });
      return { ok: true, value: null };
    });
    render(<MemoryRouter><MetadataEditRoute archiveId="a" /></MemoryRouter>);
    try {
      expect(await screen.findByRole('textbox', { name: '标题' })).toHaveValue('Title a');
    } finally { await act(async () => finish({ ok: true, value: [] })); }
  });

  it('discards an old plugin result after opening another archive', async () => {
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return servers;
      if (command === 'load_archive_metadata') return metadata(String(args?.archiveId));
      if (command === 'list_metadata_plugins') return { ok: true, value: [{ id: 'eh', name: 'E-Hentai' }] };
      if (command === 'use_metadata_plugin') return new Promise(resolve => { finish = resolve; });
      return { ok: true, value: null };
    });
    const view = render(<MemoryRouter><MetadataEditRoute archiveId="a" /></MemoryRouter>);
    await screen.findByRole('textbox', { name: '标题' });
    fireEvent.click(await screen.findByRole('button', { name: '执行插件' }));
    await waitFor(() => expect(finish).toBeDefined());
    view.rerender(<MemoryRouter><MetadataEditRoute archiveId="b" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('Title b'));
    await act(async () => finish({ ok: true, value: { data: { title: 'Old plugin title', tags: 'artist:old' } } }));
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('Title b');
    expect(screen.getByRole('button', { name: '保存元数据' })).toBeEnabled();
  });
});
