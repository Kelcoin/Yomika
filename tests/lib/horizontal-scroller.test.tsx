import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { getHorizontalWheelDelta, useHorizontalScroller } from '../../src/lib/horizontalScroller';

function HorizontalScrollerHarness({ onOuterWheel }: { onOuterWheel: () => void }) {
  const scroller = useHorizontalScroller();
  return (
    <div onWheel={onOuterWheel}>
      <div
        ref={scroller.ref}
        data-testid="rail"
        onMouseDown={scroller.onMouseDown}
        onClickCapture={scroller.onClickCapture}
        onDragStart={scroller.onDragStart}
      />
    </div>
  );
}

function setOverflow(element: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, value: scrollWidth },
    clientWidth: { configurable: true, value: clientWidth },
  });
}

describe('horizontal scroller', () => {
  it('takes a wheel that is going sideways', () => {
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: false, deltaX: -90, deltaY: 30 }, 500, 200)).toBe(-90);
    // A mouse has no deltaX: shift+wheel is how it asks, and Chromium reports one
    // axis or the other depending on the platform.
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: true, deltaX: 0, deltaY: 80 }, 500, 200)).toBe(80);
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: true, deltaX: 60, deltaY: 0 }, 500, 200)).toBe(60);
  });

  it('leaves a vertical wheel, ctrl+wheel and non-overflowing content to the page', () => {
    // The regression: a vertical wheel over a rail used to be converted, so the
    // page could not be scrolled while the pointer was over the cards — and the
    // rails span nearly the whole viewport.
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: false, deltaX: 0, deltaY: 80 }, 500, 200)).toBeNull();
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: false, deltaX: 20, deltaY: 80 }, 500, 200)).toBeNull();
    expect(getHorizontalWheelDelta({ ctrlKey: true, shiftKey: false, deltaX: 0, deltaY: 80 }, 500, 200)).toBeNull();
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: false, deltaX: 0, deltaY: 80 }, 200, 200)).toBeNull();
  });

  it('moves an overflowing rail horizontally and contains its wheel event', () => {
    const onOuterWheel = vi.fn();
    render(<HorizontalScrollerHarness onOuterWheel={onOuterWheel} />);
    const rail = screen.getByTestId('rail');
    setOverflow(rail, 800, 200);

    fireEvent.wheel(rail, { deltaX: 50 });

    expect(rail.scrollLeft).toBe(120);
    expect(onOuterWheel).not.toHaveBeenCalled();
  });

  it('lets a vertical wheel over the cards scroll the page', () => {
    const onOuterWheel = vi.fn();
    render(<HorizontalScrollerHarness onOuterWheel={onOuterWheel} />);
    const rail = screen.getByTestId('rail');
    setOverflow(rail, 800, 200);

    fireEvent.wheel(rail, { deltaY: 50 });

    expect(rail.scrollLeft).toBe(0);
    expect(onOuterWheel).toHaveBeenCalledTimes(1);
  });

  it('does not contain wheel input when the rail cannot scroll', () => {
    const onOuterWheel = vi.fn();
    render(<HorizontalScrollerHarness onOuterWheel={onOuterWheel} />);
    const rail = screen.getByTestId('rail');
    setOverflow(rail, 200, 200);

    fireEvent.wheel(rail, { deltaX: 50 });

    expect(rail.scrollLeft).toBe(0);
    expect(onOuterWheel).toHaveBeenCalledTimes(1);
  });

  it('hands the wheel to the page once the rail has reached either end', () => {
    const onOuterWheel = vi.fn();
    render(<HorizontalScrollerHarness onOuterWheel={onOuterWheel} />);
    const rail = screen.getByTestId('rail');
    setOverflow(rail, 800, 200);
    Object.defineProperty(rail, 'scrollLeft', { configurable: true, writable: true, value: 599 });

    // Already at the right end: further rightward wheel belongs to the page.
    fireEvent.wheel(rail, { deltaX: 50 });
    expect(onOuterWheel).toHaveBeenCalledTimes(1);

    Object.defineProperty(rail, 'scrollLeft', { configurable: true, writable: true, value: 0 });
    // Back at the start: a leftward wheel passes through instead of sticking.
    fireEvent.wheel(rail, { deltaX: -50 });
    expect(onOuterWheel).toHaveBeenCalledTimes(2);

    // Mid-rail the rail still owns a sideways wheel.
    fireEvent.wheel(rail, { deltaX: 50 });
    expect(rail.scrollLeft).toBe(120);
    expect(onOuterWheel).toHaveBeenCalledTimes(2);
  });

  it('swallows the click that ends a drag', () => {
    render(<HorizontalScrollerHarness onOuterWheel={vi.fn()} />);
    const rail = screen.getByTestId('rail');
    setOverflow(rail, 800, 200);

    fireEvent.mouseDown(rail, { button: 0, clientX: 120 });
    fireEvent.mouseMove(window, { clientX: 60 });
    fireEvent.mouseUp(window);

    expect(rail.scrollLeft).toBe(60);
    expect(fireEvent.click(rail)).toBe(false);
  });

  it('stops suppressing clicks once the drag window has passed', () => {
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1_000);
    render(<HorizontalScrollerHarness onOuterWheel={vi.fn()} />);
    const rail = screen.getByTestId('rail');
    setOverflow(rail, 800, 200);

    fireEvent.mouseDown(rail, { button: 0, clientX: 120 });
    fireEvent.mouseMove(window, { clientX: 60 });
    fireEvent.mouseUp(window);
    // A drag released outside the rail produces no click. A later keyboard
    // activation arrives as a click with no preceding mousedown, and must pass.
    clock.mockReturnValue(2_000);

    expect(fireEvent.click(rail)).toBe(true);
    clock.mockRestore();
  });
});
