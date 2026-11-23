import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { mapPanelDepth, usePanelPager } from '../../src/lib/usePanelPager';

const order = ['details', 'comments'] as const;
function Pager() {
  const [panel, setPanel] = useState<(typeof order)[number]>('details');
  const pager = usePanelPager({ order, panel, enabled: true, onChange: setPanel });
  return <><button onClick={() => pager.goTo('details')}>Details</button><button onClick={() => pager.goTo('comments')} aria-pressed={pager.selectedPanel === 'comments'}>Comments</button><output>{panel}</output><output data-testid="selected">{pager.selectedPanel}</output><div ref={pager.containerRef} className={pager.containerClass} data-testid="stage">
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
  it('places both panels before starting a button transition', () => {
    const origins: string[] = [];
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function(this: HTMLElement) {
      origins.push(this.style.transform);
      return { cancel: vi.fn(), onfinish: null } as unknown as Animation;
    } });
    render(<Pager />);
    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
    expect(origins).toEqual(['translate3d(0px, 0, 0)', 'translate3d(calc(100% + 16px), 0, 0)']);
  });

  it('repositions the scrollport after a long-to-short transition and restores the long panel on return', () => {
    render(<div data-testid="scrollport" style={{ overflowY: 'auto' }}><Pager /></div>);
    const host = screen.getByTestId('scrollport');
    const stage = screen.getByTestId('stage');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 768, height: 768 } as DOMRect);
    vi.spyOn(stage, 'getBoundingClientRect').mockImplementation(() => ({ top: 300 - host.scrollTop, height: 6000 } as DOMRect));
    vi.spyOn(screen.getByTestId('details'), 'scrollHeight', 'get').mockReturnValue(6000);
    vi.spyOn(screen.getByTestId('comments'), 'scrollHeight', 'get').mockReturnValue(600);
    host.scrollTop = 5000;
    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
    expect(host.scrollTop).toBe(300);
    expect(screen.getByTestId('comments').hidden).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(host.scrollTop).toBe(5000);
    expect(screen.getByTestId('details').hidden).toBe(false);
  });

  it('keeps the scroll position when switching while the tabs are visible', () => {
    render(<div data-testid="scrollport" style={{ overflowY: 'auto' }}><Pager /></div>);
    const host = screen.getByTestId('scrollport');
    const stage = screen.getByTestId('stage');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 768, height: 768 } as DOMRect);
    vi.spyOn(stage, 'getBoundingClientRect').mockImplementation(() => ({ top: 300 - host.scrollTop, height: 6000 } as DOMRect));
    vi.spyOn(screen.getByTestId('details'), 'scrollHeight', 'get').mockReturnValue(6000);
    vi.spyOn(screen.getByTestId('comments'), 'scrollHeight', 'get').mockReturnValue(600);
    host.scrollTop = 1500;
    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
    host.scrollTop = 100;
    const comments = screen.getByTestId('comments');
    fireEvent.touchStart(comments, { touches: [touch(150)] });
    fireEvent.touchMove(comments, { touches: [touch(240)] });
    fireEvent.touchEnd(comments, { touches: [] });
    expect(screen.getByTestId('selected')).toHaveTextContent('details');
    expect(host.scrollTop).toBe(100);
  });

  it('maps a deep visit into a short panel and restores each panel independently', () => {
    expect(mapPanelDepth(1800, 3000, 900, 600)).toBe(225);
    expect(mapPanelDepth(1800, 3000, 400, 600)).toBe(0);
    expect(mapPanelDepth(200, 900, 3000, 600, 1800)).toBe(1800);
    expect(mapPanelDepth(200, 900, 800, 600, 1800)).toBe(200);
    expect(mapPanelDepth(0, 400, 3000, 600)).toBe(0);
  });
  it('freezes the outgoing stage during a swipe and keeps a short target from clamping the outer scroll', () => {
    render(<Pager />);
    const stage = screen.getByTestId('stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ top: -400, bottom: 800, height: 1200 } as DOMRect);
    const details = screen.getByTestId('details');
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(160)] });
    expect(stage.style.height).toBe('1200px');
    fireEvent.touchEnd(details, { touches: [] });
    expect(stage.style.height).toBe('');
    expect(parseFloat(stage.style.minHeight)).toBe(window.innerHeight);
    expect(screen.getAllByText('comments', { selector: 'output' })).toHaveLength(2);
  });

  it('measures both panels before revealing the incoming panel and reuses geometry through release', () => {
    render(<Pager />);
    const stage = screen.getByTestId('stage');
    const details = screen.getByTestId('details');
    const comments = screen.getByTestId('comments');
    const width = vi.spyOn(stage, 'clientWidth', 'get').mockReturnValue(400);
    const reads: boolean[] = [];
    const height = vi.spyOn(comments, 'scrollHeight', 'get').mockImplementation(() => {
      reads.push(comments.hidden);
      return 900;
    });
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(220)] });
    expect(reads).toEqual([true]);
    fireEvent.touchMove(details, { touches: [touch(260)] });
    fireEvent.touchMove(details, { touches: [touch(160)] });
    fireEvent.touchEnd(details, { touches: [] });
    expect(height).toHaveBeenCalledTimes(1);
    expect(width).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('selected')).toHaveTextContent('comments');
  });

  it('waits through an ambiguous diagonal start rather than rejecting the whole swipe', () => {
    render(<Pager />);
    const details = screen.getByTestId('details');
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(231, 109)] });
    fireEvent.touchMove(details, { touches: [touch(160, 115)] });
    fireEvent.touchEnd(details, { touches: [] });
    expect(screen.getAllByText('comments', { selector: 'output' })).toHaveLength(2);
  });

  it('accepts a clearly horizontal noncancelable stream after a native vertical fling', () => {
    render(<Pager />);
    const details = screen.getByTestId('details');
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(160, 102)], cancelable: false });
    fireEvent.touchEnd(details, { touches: [] });
    expect(screen.getAllByText('comments', { selector: 'output' })).toHaveLength(2);
  });

  it('paints both panels while dragging, then settles from that exact position and retains children', () => {
    const animations: Array<{ onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> }> = [];
    const animate = vi.fn((_frames: Keyframe[] | PropertyIndexedKeyframes | null, _options?: number | KeyframeAnimationOptions) => {
      const animation = { onfinish: null, cancel: vi.fn(() => {
        // Teardown must happen only after React commits the target layout.
        expect(screen.getByTestId('details').hidden).toBe(true);
        expect(screen.getByTestId('comments').hidden).toBe(false);
        expect(screen.getByTestId('stage')).not.toHaveClass('is-sliding');
      }) };
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
    expect(screen.getByTestId('selected')).toHaveTextContent('comments');
    expect(comments).not.toHaveAttribute('inert');
    expect(details).toHaveAttribute('inert');
    expect(animations[0]?.cancel).not.toHaveBeenCalled();
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { transform: 'translate3d(-70px, 0, 0)' }, { transform: 'translate3d(calc(-100% - 16px), 0, 0)' },
    ]);
    act(() => animations.at(-1)?.onfinish?.());
    expect(screen.getAllByText('comments', { selector: 'output' })).toHaveLength(2);
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
    expect(screen.getAllByText('comments', { selector: 'output' })).toHaveLength(2);
    expect(screen.getByTestId('stage')).not.toHaveClass('is-sliding');
  });

  it('selects the destination immediately for a clicked tab while keeping both panels on stage', () => {
    const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    render(<Pager />);
    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
    expect(screen.getByRole('button', { name: 'Comments' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('details').hidden).toBe(false);
    expect(screen.getByTestId('comments').hidden).toBe(false);
    expect(screen.getByTestId('stage')).toHaveClass('is-sliding');
  });

  it('keeps the incoming panel visible through a short-drag snap-back', () => {
    const animations: Array<{ onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> }> = [];
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    render(<Pager />);
    const details = screen.getByTestId('details');
    const comments = screen.getByTestId('comments');
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(220)] });
    fireEvent.touchEnd(details, { touches: [] });
    expect(comments.hidden).toBe(false);
    expect(screen.getByTestId('selected')).toHaveTextContent('details');
    act(() => animations.at(-1)?.onfinish?.());
    expect(comments.hidden).toBe(true);
    expect(details.style.transform).toBe('');
  });

  it('cancels an in-progress drag when another finger joins', () => {
    render(<Pager />);
    const details = screen.getByTestId('details');
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(160)] });
    fireEvent.touchStart(details, { touches: [touch(160), touch(200)] });
    expect(screen.getByTestId('stage')).not.toHaveClass('is-sliding');
    expect(details.style.transform).toBe('');
    expect(screen.getAllByText('details', { selector: 'output' })).toHaveLength(2);
  });

  it('reverses direction across the origin without turning to the stale neighbor', () => {
    render(<Pager />);
    const details = screen.getByTestId('details');
    fireEvent.touchStart(details, { touches: [touch(240)] });
    fireEvent.touchMove(details, { touches: [touch(160)] });
    fireEvent.touchMove(details, { touches: [touch(330)] });
    fireEvent.touchEnd(details, { touches: [] });
    expect(screen.getAllByText('details', { selector: 'output' })).toHaveLength(2);
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
