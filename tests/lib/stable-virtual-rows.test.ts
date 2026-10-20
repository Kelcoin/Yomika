import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useStableVirtualRows } from '../../src/lib/useStableVirtualRows';

it('keeps mounted cards during a hidden viewport collapse but accepts real visible changes', () => {
  const hook = renderHook(({ items, measurable, count }) => useStableVirtualRows(items, 10000, count, measurable), {
    initialProps: { items: [45, 46, 47, 48, 49], measurable: true, count: 100 },
  });
  hook.rerender({ items: [0], measurable: false, count: 100 });
  expect(hook.result.current.items).toEqual([45, 46, 47, 48, 49]);
  hook.rerender({ items: [], measurable: false, count: 100 });
  expect(hook.result.current.items).toEqual([45, 46, 47, 48, 49]);
  hook.rerender({ items: [98, 99], measurable: true, count: 100 });
  expect(hook.result.current.items).toEqual([98, 99]);
  hook.rerender({ items: [], measurable: false, count: 0 });
  expect(hook.result.current.items).toEqual([]);
});
