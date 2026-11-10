import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { usePanelPager } from '../../src/lib/usePanelPager';

const order = ['details', 'comments'] as const;
function Pager() {
  const [panel, setPanel] = useState<(typeof order)[number]>('details');
  const pager = usePanelPager({ order, panel, enabled: true, onChange: setPanel });
  return <><output>{panel}</output><div ref={pager.containerRef} className={pager.containerClass} data-testid="stage">
    <div {...pager.panelProps('details')} data-testid="details"><a href="#target">Open</a></div>
    <div {...pager.panelProps('comments')} data-testid="comments"><input aria-label="draft" defaultValue="retained" /></div>
  </div></>;
}
const touch = (x: number, y = 100) => ({ clientX: x, clientY: y });
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

describe('panel gesture lifecycle', () => {
  it('paints both panels while dragging, then settles from that exact position and retains children', () => {
    const animations: Array<{ onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> }> = [];
    const animate = vi.fn((_frames: Keyframe[] | PropertyIndexedKeyframes | null, _options?: number | KeyframeAnimationOptions) => {
      const animation = { onfinish: null, cancel: vi.fn() };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    render(<Pager />);
    const details = screen.getByTestId('details');
    const comments = screen.getByTestId('comments');
    const input = comments.querySelector('input');
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(170)] });
    expect(details.style.transform).toBe('translate3d(-70px, 0, 0)');
    expect(comments.hidden).toBe(false);
    expect(comments).toHaveAttribute('inert');
    fireEvent.touchEnd(details, { touches: [] });
    expect(screen.getByTestId('stage')).toHaveClass('is-sliding');
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { transform: 'translate3d(-70px, 0, 0)' }, { transform: 'translate3d(-100%, 0, 0)' },
    ]);
    act(() => animations.at(-1)?.onfinish?.());
    expect(screen.getByText('comments', { selector: 'output' })).toBeInTheDocument();
    expect(comments.querySelector('input')).toBe(input);
    expect(comments).not.toHaveAttribute('inert');
  });

  it('settles immediately with reduced motion even when animations are available', () => {
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion') } as MediaQueryList));
    render(<Pager />);
    const details = screen.getByTestId('details');
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(160)] });
    fireEvent.touchEnd(details, { touches: [] });
    expect(animate).not.toHaveBeenCalled();
    expect(screen.getByText('comments', { selector: 'output' })).toBeInTheDocument();
    expect(screen.getByTestId('stage')).not.toHaveClass('is-sliding');
  });

  it('cancels an in-progress drag when another finger joins', () => {
    render(<Pager />);
    const details = screen.getByTestId('details');
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(160)] });
    fireEvent.touchStart(details, { touches: [touch(160), touch(200)] });
    expect(screen.getByTestId('stage')).not.toHaveClass('is-sliding');
    expect(details.style.transform).toBe('');
    expect(screen.getByText('details', { selector: 'output' })).toBeInTheDocument();
  });

  it('reverses direction across the origin without turning to the stale neighbor', () => {
    render(<Pager />);
    const details = screen.getByTestId('details');
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(160)] });
    fireEvent.touchMove(details, { touches: [touch(330)] });
    fireEvent.touchEnd(details, { touches: [] });
    expect(screen.getByText('details', { selector: 'output' })).toBeInTheDocument();
    expect(screen.getByTestId('stage')).not.toHaveClass('is-sliding');
  });

  it('preserves link taps and vertical drags, suppressing clicks only after a horizontal drag', () => {
    render(<Pager />);
    const link = screen.getByRole('link');
    fireEvent.touchStart(link, { touches: [touch(240)] });
    fireEvent.touchEnd(link, { touches: [] });
    expect(fireEvent.click(link)).toBe(true);
    fireEvent.touchStart(link, { touches: [touch(240)] });
    fireEvent.touchMove(link, { touches: [touch(230, 200)] });
    fireEvent.touchEnd(link, { touches: [] });
    expect(fireEvent.click(link)).toBe(true);
    fireEvent.touchStart(link, { touches: [touch(240)] });
    fireEvent.touchMove(link, { touches: [touch(220)] });
    fireEvent.touchEnd(link, { touches: [] });
    expect(fireEvent.click(link)).toBe(false);
  });
});
