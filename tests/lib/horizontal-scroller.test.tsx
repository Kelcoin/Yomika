import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import {
  COARSE_POINTER_QUERY,
  getHorizontalWheelDelta,
  getMouseScrollStyle,
  getTouchScrollStyle,
  useHorizontalScroller,
} from '../../src/lib/horizontalScroller';

/** jsdom 里没有 `matchMedia`：给导轨一个能改判的桩，用来验「按设备档挑样式」那一档。 */
function stubCoarsePointer(initial: boolean) {
  type Listener = () => void;
  const listeners = new Set<Listener>();
  let matches = initial;
  const media = {
    media: COARSE_POINTER_QUERY,
    get matches() {
      return matches;
    },
    addEventListener: (_type: string, listener: Listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => {
      listeners.delete(listener);
    },
    addListener: (listener: Listener) => {
      listeners.add(listener);
    },
    removeListener: (listener: Listener) => {
      listeners.delete(listener);
    },
    onchange: null,
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  const previous = window.matchMedia;
  (window as unknown as { matchMedia: (query: string) => MediaQueryList }).matchMedia = () => media;
  return {
    flip(next: boolean) {
      matches = next;
      listeners.forEach((listener) => listener());
    },
    restore() {
      (window as unknown as { matchMedia: typeof previous }).matchMedia = previous;
    },
  };
}

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
  it('keeps native touch inertia unsnapped until scrolling has actually stopped', () => {
    vi.useFakeTimers();
    try {
      render(<HorizontalScrollerHarness onOuterWheel={() => {}} />);
      const rail = screen.getByTestId('rail');
      setOverflow(rail, 2000, 500);
      rail.style.scrollSnapType = 'x proximity';
      fireEvent.touchStart(rail, { touches: [{ clientX: 400, clientY: 0 }] });
      expect(rail.style.scrollSnapType).toBe('none');
      fireEvent.touchEnd(rail);
      vi.advanceTimersByTime(100);
      fireEvent.scroll(rail);
      vi.advanceTimersByTime(100);
      expect(rail.style.scrollSnapType).toBe('none');
      fireEvent(rail, new Event('scrollend'));
      expect(rail.style.scrollSnapType).toBe('x proximity');
      fireEvent.touchStart(rail, { touches: [{ clientX: 400, clientY: 0 }] });
      fireEvent.touchCancel(rail);
      expect(rail.style.scrollSnapType).toBe('x proximity');
    } finally { vi.useRealTimers(); }
  });
  it('hands a touch device the browser’s own scrolling and a mouse a grab cursor', () => {
    const touch = getTouchScrollStyle();
    // 触摸这一路整个交给浏览器：两个轴都由它按手势主方向择一，所以**不能**是
    // `pan-x` / `pan-x pan-y`——后者会把双指缩放一起禁掉，而缩放该由浏览器决定。
    expect(touch.touchAction).toBe('auto');
    expect(touch.overscrollBehaviorX).toBe('contain');
    expect(touch.overscrollBehaviorY).toBe('auto');
    expect(String(touch.touchAction)).not.toContain('pan');

    expect(getMouseScrollStyle().cursor).toBe('grab');
  });

  it('puts the touch style on the rail where there is no hover, and follows a change', () => {
    const pointer = stubCoarsePointer(true);
    try {
      render(<HorizontalScrollerHarness onOuterWheel={vi.fn()} />);
      const rail = screen.getByTestId('rail');
      expect(rail.style.touchAction).toBe('auto');
      expect(rail.style.overscrollBehaviorX).toBe('contain');
      expect(rail.style.cursor).toBe('');

      // 插上鼠标 / 切回桌面模式：换那一套，而且要把触摸那套留下的键清掉。
      pointer.flip(false);
      expect(rail.style.cursor).toBe('grab');
      expect(rail.style.touchAction).toBe('');
    } finally {
      pointer.restore();
    }
  });

  it('takes a wheel that is going sideways, and a vertical wheel over the cards', () => {
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: false, deltaX: -90, deltaY: 30 }, 500, 200)).toBe(-90);
    // The plain vertical wheel moves the rail too — that is how a mouse asks a
    // horizontal strip to move. The strip retains wheel ownership at either end.
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: false, deltaX: 0, deltaY: 80 }, 500, 200)).toBe(80);
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: false, deltaX: 20, deltaY: 80 }, 500, 200)).toBe(80);
    // A mouse has no deltaX: shift+wheel is how it asks, and Chromium reports one
    // axis or the other depending on the platform.
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: true, deltaX: 0, deltaY: 80 }, 500, 200)).toBe(80);
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: true, deltaX: 60, deltaY: 0 }, 500, 200)).toBe(60);
  });

  it('leaves ctrl+wheel, zero deltas and non-overflowing content to the page', () => {
    // ctrl+wheel is zoom; a rail without overflow has nothing to scroll.
    expect(getHorizontalWheelDelta({ ctrlKey: true, shiftKey: false, deltaX: 0, deltaY: 80 }, 500, 200)).toBeNull();
    expect(getHorizontalWheelDelta({ ctrlKey: false, shiftKey: false, deltaX: 0, deltaY: 0 }, 500, 200)).toBeNull();
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

  it('moves an overflowing rail with a plain vertical wheel and contains the event', () => {
    const onOuterWheel = vi.fn();
    render(<HorizontalScrollerHarness onOuterWheel={onOuterWheel} />);
    const rail = screen.getByTestId('rail');
    setOverflow(rail, 800, 200);

    fireEvent.wheel(rail, { deltaY: 50 });

    expect(rail.scrollLeft).toBe(120);
    expect(onOuterWheel).not.toHaveBeenCalled();
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

  it('retains wheel ownership when a fresh gesture begins at either end', () => {
    const outer = vi.fn();
    render(<HorizontalScrollerHarness onOuterWheel={outer} />);
    const rail = screen.getByTestId('rail');
    setOverflow(rail, 800, 200);
    for (const [position, delta] of [[0, -50], [600, 50]]) {
      rail.scrollLeft = position!;
      const event = new WheelEvent('wheel', { deltaY: delta!, bubbles: true, cancelable: true });
      rail.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(outer).not.toHaveBeenCalled();
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

describe('mouse rail release motion', () => {
  it('decelerates after release and stops immediately for new input', () => {
    let at = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => at);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++nextId, callback); return nextId; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
    const view = render(<HorizontalScrollerHarness onOuterWheel={vi.fn()} />);
    const rail = screen.getByTestId('rail');
    setOverflow(rail, 2000, 300);
    rail.style.scrollSnapType = 'x proximity';
    rail.scrollLeft = 200;
    fireEvent.mouseDown(rail, { button: 0, clientX: 120 });
    expect(rail.style.scrollSnapType).toBe('none');
    at = 40;
    fireEvent.mouseMove(window, { clientX: 80 });
    fireEvent.mouseUp(window);
    expect(frames.size).toBe(1);
    const advance = () => {
      const [id, callback] = [...frames.entries()][0]!;
      frames.delete(id);
      at += 16;
      callback(at);
    };
    const released = rail.scrollLeft;
    advance();
    const firstStep = rail.scrollLeft - released;
    advance();
    expect(rail.scrollLeft - released - firstStep).toBeGreaterThan(0);
    expect(rail.scrollLeft - released - firstStep).toBeLessThan(firstStep);
    fireEvent.touchStart(rail);
    expect(frames.size).toBe(0);
    expect(rail.style.scrollSnapType).toBe('none');
    fireEvent.touchCancel(rail);
    expect(rail.style.scrollSnapType).toBe('x proximity');
    view.unmount();
    vi.restoreAllMocks();
  });

  it('does not coast after a held release or when reduced motion is requested', () => {
    let at = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => at);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const view = render(<HorizontalScrollerHarness onOuterWheel={vi.fn()} />);
    const rail = screen.getByTestId('rail');
    setOverflow(rail, 2000, 300);
    fireEvent.mouseDown(rail, { button: 0, clientX: 120 });
    at = 40; fireEvent.mouseMove(window, { clientX: 80 });
    at = 200; fireEvent.mouseUp(window);
    expect(raf).not.toHaveBeenCalled();
    const pointer = stubCoarsePointer(true); // also satisfies reduced-motion query
    fireEvent.mouseDown(rail, { button: 0, clientX: 120 });
    at = 240; fireEvent.mouseMove(window, { clientX: 80 });
    fireEvent.mouseUp(window);
    expect(raf).not.toHaveBeenCalled();
    pointer.restore();
    view.unmount();
    vi.restoreAllMocks();
  });
});
