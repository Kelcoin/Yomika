import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VirtualPageGrid } from '../../src/components/VirtualPageGrid';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('bounds a 10,000-page grid to visible rows and scrolls to distant pages', () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  const computed = globalThis.getComputedStyle;
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((node) => {
    const style = computed(node);
    if (node.classList.contains('page-grid')) {
      Object.defineProperty(style, 'overflowY', { value: 'auto' });
      Object.defineProperty(style, 'columnGap', { value: '8px' });
    }
    return style;
  });
  const onRangeChange = vi.fn();
  const view = render(<VirtualPageGrid count={10000} className="page-grid" minWidth={72} onRangeChange={onRangeChange}>
    {(index) => <button key={index}>Page {index + 1}</button>}
  </VirtualPageGrid>);
  const grid = view.container.firstElementChild as HTMLElement;
  expect(screen.getAllByRole('button').length).toBeLessThan(50);
  expect(screen.getByRole('button', { name: 'Page 1' })).toBeInTheDocument();
  grid.scrollTop = 20000;
  fireEvent.scroll(grid);
  act(() => vi.advanceTimersByTime(32));
  expect(screen.queryByRole('button', { name: 'Page 1' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('button').length).toBeLessThan(50);
  expect(onRangeChange.mock.lastCall?.[0]).toBeGreaterThan(500);
  grid.scrollTop = 300000;
  fireEvent.scroll(grid);
  act(() => vi.advanceTimersByTime(32));
  expect(screen.getByRole('button', { name: 'Page 10000' })).toBeInTheDocument();
});
