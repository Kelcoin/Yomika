import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PatternLock } from '../src/components/PatternLock';
import { appendPatternPoint } from '../src/lib/patternLock';

afterEach(cleanup);
it('includes only an unused midpoint and rejects repeated points', () => {
  expect(appendPatternPoint([0], 2)).toEqual([0, 1, 2]);
  expect(appendPatternPoint([0], 8)).toEqual([0, 4, 8]);
  expect(appendPatternPoint([0, 1, 2], 0)).toEqual([0, 1, 2]);
  expect(appendPatternPoint([1, 0], 2)).toEqual([1, 0, 2]);
});
it('supports keyboard entry with four nodes and rejects shorter patterns', () => {
  const complete = vi.fn();
  render(<PatternLock label="手势" onComplete={complete} />);
  fireEvent.click(screen.getByRole('button', { name: '手势：点 1' }));
  expect(complete).toHaveBeenLastCalledWith('');
  expect(screen.queryByRole('button', { name: '完成手势' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '手势：点 3' }));
  fireEvent.click(screen.getByRole('button', { name: '手势：点 6' }));
  expect(complete).toHaveBeenLastCalledWith('0125');
});
it('captures a pointer, completes a drag and clears cancelled gestures without submission', () => {
  const complete = vi.fn();
  render(<PatternLock label="手势" onComplete={complete} />);
  const grid = screen.getByRole('group', { name: '手势' });
  vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
  const capture = vi.fn(); Object.assign(grid, { setPointerCapture: capture, releasePointerCapture: vi.fn() });
  const pointer = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerId: 4, button: 0, clientX: x, clientY: y });
    fireEvent(grid, event);
  };
  pointer('pointerdown', 50, 50); pointer('pointermove', 250, 50); pointer('pointerup', 250, 150);
  expect(capture).toHaveBeenCalledWith(4);
  expect(complete).toHaveBeenLastCalledWith('0125');
  pointer('pointerdown', 50, 50); pointer('pointermove', 250, 250); pointer('pointercancel', 250, 250);
  expect(complete).toHaveBeenLastCalledWith('');
  expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
});

