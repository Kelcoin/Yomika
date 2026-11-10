import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { useArchiveReadingProgress } from '../../src/components/useArchiveReadingProgress';
import { invalidateRouteCache } from '../../src/lib/routeCache';

afterEach(resetInvokeAdapterForTests);

function Status() {
  const { hasProgress } = useArchiveReadingProgress('scope', 'archive');
  return <span>{hasProgress ? '有阅读进度' : '没有阅读进度'}</span>;
}

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
