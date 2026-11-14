import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { useArchiveReadingProgress } from '../../src/components/useArchiveReadingProgress';
import { invalidateRouteCache } from '../../src/lib/routeCache';

afterEach(resetInvokeAdapterForTests);

function Status() {
  const { hasProgress } = useArchiveReadingProgress('scope', 'archive');
  return <span>{hasProgress ? '有阅读进度' : '没有阅读进度'}</span>;
}

it('offers retry on an initial read failure and preserves confirmed progress when a refresh fails', async () => {
  let failing = true;
  setInvokeAdapterForTests(async () => failing
    ? { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'offline', retryable: true } }
    : { ok: true, value: { scopeId: 'scope', archiveId: 'archive', pageIndex: 4, pageCount: 20, layout: 'paged', direction: 'ltr', updatedAt: 'now', revision: 1 } });
  function Probe() {
    const progress = useArchiveReadingProgress('scope', 'archive');
    return <button onClick={progress.retry}>{progress.ready ? progress.hasProgress ? '继续' : '阅读' : progress.error ? '重试' : '加载'}</button>;
  }
  render(<Probe />);
  await screen.findByRole('button', { name: '重试' });
  expect(screen.queryByRole('button', { name: '阅读' })).toBeNull();
  failing = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByRole('button', { name: '继续' });
  failing = true;
  await act(async () => invalidateRouteCache('state:'));
  expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
});

it('updates an already mounted reading status for full sync invalidations in both directions', async () => {
  let value: unknown = null;
  setInvokeAdapterForTests(async () => ({ ok: true, value }));
  render(<Status />);
  await screen.findByText('没有阅读进度');
  value = { scopeId: 'scope', archiveId: 'archive', pageIndex: 0, pageCount: 259, layout: 'paged', direction: 'ltr', updatedAt: 'now', revision: 1 };
  act(() => invalidateRouteCache());
  await screen.findByText('有阅读进度');
  value = null;
  act(() => invalidateRouteCache());
  await screen.findByText('没有阅读进度');
});

it('does not restore a late progress snapshot after clearing the archive', async () => {
  let finishRead!: (value: unknown) => void;
  let reads = 0;
  setInvokeAdapterForTests(async command => {
    if (command === 'load_reading_progress' && ++reads === 1) return new Promise(resolve => { finishRead = resolve; });
    return { ok: true, value: null };
  });
  function Probe() {
    const progress = useArchiveReadingProgress('scope', 'archive');
    return <><button onClick={() => void progress.clear()} disabled={progress.busy}>清除</button><span>{progress.hasProgress ? '有进度' : '无进度'}</span></>;
  }
  render(<Probe />);
  await waitFor(() => expect(finishRead).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: '清除' }));
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  await act(async () => finishRead({ ok: true, value: { scopeId: 'scope', archiveId: 'archive', pageIndex: 8, pageCount: 20, layout: 'paged', direction: 'ltr', updatedAt: 'now', revision: 1 } }));
  expect(screen.getByText('无进度')).toBeInTheDocument();
});

it('ignores reads from the previous archive after the detail component is reused', async () => {
  let finishRead!: (value: unknown) => void;
  setInvokeAdapterForTests(async (_command, args) => args?.archiveId === 'old'
    ? new Promise(resolve => { finishRead = resolve; })
    : { ok: true, value: null });
  function Probe({ archiveId }: { archiveId: string }) {
    const progress = useArchiveReadingProgress('scope', archiveId);
    return <span>{progress.ready ? progress.hasProgress ? '有进度' : '无进度' : '读取中'}</span>;
  }
  const view = render(<Probe archiveId="old" />);
  await waitFor(() => expect(finishRead).toBeDefined());
  view.rerender(<Probe archiveId="new" />);
  await screen.findByText('无进度');
  await act(async () => finishRead({ ok: true, value: { scopeId: 'scope', archiveId: 'old', pageIndex: 8, pageCount: 20, layout: 'paged', direction: 'ltr', updatedAt: 'now', revision: 1 } }));
  expect(screen.getByText('无进度')).toBeInTheDocument();
});
