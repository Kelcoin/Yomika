import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { PreferencesProvider } from '../../src/app/preferences';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { LocalReaderRoute } from '../../src/components/LocalReaderRoute';
import { ToastProvider } from '../../src/components/Toast';
import { localReaderUrl } from '../../src/repositories/localArchiveReader';

const first = 'first.cbz';
const second = 'second.cbz';
function SwitchArchive() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(localReaderUrl(second))}>Switch archive</button>;
}

afterEach(() => { resetInvokeAdapterForTests(); vi.unstubAllGlobals(); });

it('waits for the new archive manifest before mounting its reader', async () => {
  const manifest = (title: string, entry: number) => ({ ok: true, value: { title, entries: [entry], tags: [], sizeBytes: 100 } });
  let resolveSecond!: (value: ReturnType<typeof manifest>) => void;
  const pendingSecond = new Promise<ReturnType<typeof manifest>>(resolve => { resolveSecond = resolve; });
  const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'load_local_archive_manifest') return args?.path === second ? pendingSecond : manifest(first, 19);
    if (command === 'local_archive_progress') return { ok: true, value: null };
    if (command === 'load_local_archive_cover') return { ok: true, value: 'data:image/jpeg;base64,YQ==' };
    return { ok: false, error: { code: 'UNKNOWN', message: 'Unavailable', retryable: false } };
  });
  setInvokeAdapterForTests(adapter);
  render(<MemoryRouter initialEntries={[localReaderUrl(first)]}>
    <PreferencesProvider><ToastProvider><SwitchArchive /><LocalReaderRoute /></ToastProvider></PreferencesProvider>
  </MemoryRouter>);

  await waitFor(() => expect(adapter).toHaveBeenCalledWith('load_local_archive_cover', { path: first }));
  fireEvent.click(screen.getByRole('button', { name: 'Switch archive' }));
  await waitFor(() => expect(adapter).toHaveBeenCalledWith('load_local_archive_manifest', { path: second }));
  expect(adapter).not.toHaveBeenCalledWith('load_local_archive_cover', { path: second });
  await act(async () => { resolveSecond(manifest(second, 27)); });
  await waitFor(() => expect(adapter).toHaveBeenCalledWith('load_local_archive_cover', { path: second }));
});

it('cancels a native page open on archive switch and releases a lease that arrives late', async () => {
  const lateFile = {
    contentHash: 'a'.repeat(64),
    lease: { leaseId: 'late-lease', artifactId: 'artifact', jobId: 'reader-local', url: 'lease:late',
      mime: 'image/jpeg', byteLength: 100, width: 100, height: 100, estimatedDecodedBytes: 40_000,
      pipelineRevision: 'initial', expiresInMs: 5000 },
  };
  let finishOpen!: (value: { ok: true; value: typeof lateFile }) => void;
  const pendingOpen = new Promise<{ ok: true; value: typeof lateFile }>(resolve => { finishOpen = resolve; });
  const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'load_local_archive_manifest') {
      return { ok: true, value: { title: args?.path, entries: [args?.path === first ? 19 : 27], tags: [], sizeBytes: 100 } };
    }
    if (command === 'local_archive_progress') return { ok: true, value: null };
    if (command === 'open_local_archive_reader_file') return args?.path === first ? pendingOpen : { ok: true, value: null };
    if (command === 'inference_cancel_page') return { ok: true, value: true };
    if (command === 'compute_artifact_release') return { ok: true, value: null };
    return { ok: false, error: { code: 'UNKNOWN', message: 'Unavailable', retryable: false } };
  });
  vi.stubGlobal('YomikaTiles', { postMessage: vi.fn() });
  setInvokeAdapterForTests(adapter);
  render(<MemoryRouter initialEntries={[localReaderUrl(first)]}>
    <PreferencesProvider><ToastProvider><SwitchArchive /><LocalReaderRoute /></ToastProvider></PreferencesProvider>
  </MemoryRouter>);

  await waitFor(() => expect(adapter).toHaveBeenCalledWith('open_local_archive_reader_file', expect.objectContaining({ path: first, entry: 19, taskId: expect.any(String) })));
  const taskId = adapter.mock.calls.find(([command]) => command === 'open_local_archive_reader_file')?.[1]?.taskId;
  fireEvent.click(screen.getByRole('button', { name: 'Switch archive' }));
  await waitFor(() => expect(adapter).toHaveBeenCalledWith('inference_cancel_page', { taskId }));
  await act(async () => { finishOpen({ ok: true, value: lateFile }); });
  expect(adapter).toHaveBeenCalledWith('compute_artifact_release', { leaseId: 'late-lease' });
  expect(adapter).not.toHaveBeenCalledWith('reader_prepare_native_slot', expect.objectContaining({ leaseId: 'late-lease' }));
});
