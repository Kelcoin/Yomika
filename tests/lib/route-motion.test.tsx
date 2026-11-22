import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetainedPage } from '../../src/app/RetainedPage';
import { NAVIGATION_ROUTES } from '../../src/lib/navigationOrder';
import { DETAIL_EXIT_MS, resolveRouteMotion } from '../../src/lib/routeMotion';
import { useWorkspaceRouteMotion } from '../../src/lib/useWorkspaceRouteMotion';

const route = (pathname: string, search = '') => ({ pathname, search });

describe('spatial navigation and detail depth', () => {
  it('follows the actual navigation order in both axes, even against history direction', () => {
    for (const compact of [true, false]) {
      for (let source = 0; source < NAVIGATION_ROUTES.length; source++) {
        for (let target = 0; target < NAVIGATION_ROUTES.length; target++) {
          if (source === target) continue;
          if (NAVIGATION_ROUTES[target] === '/settings' || (NAVIGATION_ROUTES[source] === '/settings' && ['/library', '/history', '/watchlist', '/to-read'].includes(NAVIGATION_ROUTES[target]!))) {
            expect(resolveRouteMotion(route(NAVIGATION_ROUTES[source]!), route(NAVIGATION_ROUTES[target]!), compact, -1).kind).toBe('fade');
            continue;
          }
          expect(resolveRouteMotion(route(NAVIGATION_ROUTES[source]!), route(NAVIGATION_ROUTES[target]!), compact, -1)).toEqual({
            kind: 'slide', axis: compact || NAVIGATION_ROUTES[target] === '/' ? 'x' : 'y', direction: target > source ? 1 : -1,
          });
        }
      }
    }
  });
  it.each([['/', '/home/a'], ['/library', '/library/a'], ['/history', '/history/a'], ['/watchlist', '/watchlist/a'], ['/to-read', '/to-read/a']])('zooms details within %s without sliding the list', (list, detail) => {
    expect(resolveRouteMotion(route(list), route(detail), true).kind).toBe('detail-open');
    expect(resolveRouteMotion(route(detail), route(list), false).kind).toBe('detail-close');
  });
  it.each(['/library', '/history', '/watchlist', '/to-read'])('slides the home tab in from the left when leaving %s', (path) => {
    const homeTab = { ...route('/'), state: { navigationTab: true } };
    for (const compact of [true, false]) {
      expect(resolveRouteMotion({ ...route(path), state: { homeEntry: true } }, homeTab, compact)).toEqual({
        kind: 'slide', axis: 'x', direction: -1,
      });
    }
  });
  it('handles local detail query routes but ignores filters, hashless same-page visits and startup', () => {
    expect(resolveRouteMotion(route('/downloads'), route('/downloads', '?path=book.zip'), true).kind).toBe('detail-open');
    expect(resolveRouteMotion(route('/downloads', '?path=book.zip'), route('/downloads'), true).kind).toBe('detail-close');
    expect(resolveRouteMotion(route('/library/a'), route('/library/b'), true).kind).toBe('detail-open');
    expect(resolveRouteMotion(route('/'), route('/library/a'), true).kind).toBe('detail-open');
    expect(resolveRouteMotion(route('/library/a'), route('/library/a', '?server=x'), true).kind).toBe('none');
    expect(resolveRouteMotion(route('/library'), route('/library', '?q=filter'), true).kind).toBe('none');
    expect(resolveRouteMotion(undefined, route('/library/a'), true).kind).toBe('none');
    expect(resolveRouteMotion(route('/history/a'), route('/library'), false)).toMatchObject({ kind: 'slide', direction: -1, axis: 'y' });
    expect(resolveRouteMotion(route('/tools/upload'), route('/tools/dedup'), false, -1)).toMatchObject({ kind: 'slide', direction: -1, axis: 'x' });
  });
  it('closes a home shortcut with a zoom when leaving through a bottom tab', () => {
    for (const path of ['/history', '/watchlist', '/to-read', '/downloads', '/settings', '/more']) {
      const shortcut = { ...route(path), state: { homeEntry: true } };
      expect(resolveRouteMotion(route('/'), shortcut, true).kind).toBe('page-open');
      expect(resolveRouteMotion(shortcut, route('/'), true, -1).kind).toBe('page-close');
      for (const target of ['/', '/library', '/history', '/watchlist', '/to-read']) {
        if (target === path) continue;
        const expected = target === '/' ? 'slide' : path === '/settings' ? 'fade' : 'page-close';
        expect(resolveRouteMotion(shortcut, { ...route(target), state: { navigationTab: true } }, true).kind).toBe(expected);
      }
    }
    expect(resolveRouteMotion(route('/'), { ...route('/library'), state: { homeEntry: true } }, true).kind).toBe('fade');
    expect(resolveRouteMotion(route('/'), route('/settings'), true).kind).toBe('fade');
    expect(resolveRouteMotion({ ...route('/history/a'), state: { homeEntry: true } }, route('/history'), true, -1).kind).toBe('detail-close');
  });
});

describe('detail exit lifecycle', () => {
  const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  });
  function Demo() {
    const actual = useLocation();
    const navigate = useNavigate();
    const { location, motion, surface } = useWorkspaceRouteMotion(actual, true, 1, true);
    return <><button onClick={() => navigate('/library/a')}>Open</button><button onClick={() => navigate('/library', { replace: true, state: { routeDirection: -1 } })}>Close</button><button onClick={() => navigate('/history')}>History</button>
      <RetainedPage active motionSurface motion={motion} surfaceRef={surface} transitionKey={location.pathname}>
        {location.pathname === '/library/a' ? <div className="library-shell-detail">Detail</div> : <input aria-label="List state" defaultValue="retained" />}
        <output>{location.pathname}</output>
      </RetainedPage></>;
  }
  function setup(reducedMotion = false) {
    const animations: Array<{ element: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions; animation: Animation }> = [];
    vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion } as MediaQueryList));
    const animate = vi.fn(function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
      animations.push({ element: this, frames, options, animation });
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate });
    render(<MemoryRouter initialEntries={['/library/a']}><Demo /></MemoryRouter>);
    return animations;
  }
  it('keeps the actual outgoing detail until shrink finishes, then releases inert and the transform', () => {
    vi.useFakeTimers();
    const animations = setup();
    fireEvent.click(screen.getByText('Close'));
    expect(screen.getByText('Detail')).toBeInTheDocument();
    expect(screen.getByText('Detail').closest('section')).toHaveAttribute('inert');
    act(() => { vi.advanceTimersByTime(20); });
    expect(animations.at(-1)?.element).toBe(screen.getByText('Detail'));
    expect(animations.at(-1)?.frames.at(-1)?.transform).toBe('scale(0.9)');
    expect(animations.at(-1)?.frames[1]?.opacity).toBe(1);
    expect(animations.at(-1)?.options.duration).toBe(180);
    expect(animations.at(-1)?.options.easing).toBe('cubic-bezier(.4, 0, 1, 1)');
    expect(animations.at(-1)?.frames.every(frame => !frame.easing)).toBe(true);
    act(() => { animations.at(-1)?.animation.onfinish?.(new Event('finish') as AnimationPlaybackEvent); });
    expect(screen.queryByText('Detail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('List state').closest('section')).not.toHaveAttribute('inert');
    expect(animations.at(-1)?.animation.cancel).toHaveBeenCalled();
  });
  it('cancels interrupted exits so a stale finish callback cannot replace a newer page', () => {
    vi.useFakeTimers();
    const animations = setup();
    fireEvent.click(screen.getByText('Close'));
    act(() => { vi.advanceTimersByTime(20); });
    const exiting = animations.at(-1)!.animation;
    fireEvent.click(screen.getByText('History'));
    act(() => { vi.advanceTimersByTime(DETAIL_EXIT_MS + 100); });
    expect(screen.getByRole('status')).toHaveTextContent('/history');
    expect(exiting.cancel).toHaveBeenCalled();
    expect(document.querySelector('[inert]')).toBeNull();
  });
  it('bounds an exit when WebView omits finish and never waits under reduced motion', () => {
    vi.useFakeTimers();
    setup();
    fireEvent.click(screen.getByText('Close'));
    act(() => { vi.advanceTimersByTime(DETAIL_EXIT_MS + 70); });
    expect(screen.getByLabelText('List state')).toBeInTheDocument();
  });
  it('skips shrink under reduced motion', () => {
    const animations = setup(true);
    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByText('Detail')).not.toBeInTheDocument();
    expect(animations).toHaveLength(0);
  });
  it('starts the missing-finish deadline after a delayed first animation frame', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 100));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    setup(); fireEvent.click(screen.getByText('Close'));
    act(() => vi.advanceTimersByTime(240));
    expect(screen.getByText('Detail')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByText('Detail')).not.toBeInTheDocument();
  });
  it('renders ordinary destinations immediately without a stale-route commit', () => {
    const visits: Array<[string, string]> = [];
    function Probe() {
      const actual = useLocation();
      const navigate = useNavigate();
      const { location } = useWorkspaceRouteMotion(actual, true, 1, true);
      visits.push([actual.pathname, location.pathname]);
      return <button onClick={() => navigate('/history')}>Go</button>;
    }
    render(<MemoryRouter initialEntries={['/library']}><Probe /></MemoryRouter>);
    visits.length = 0;
    fireEvent.click(screen.getByText('Go'));
    expect(visits.length).toBeGreaterThan(0);
    expect(visits.every(([actual, displayed]) => actual === '/history' && displayed === actual)).toBe(true);
  });
  it.each(['/', '/library', '/history'])('keeps a shortcut page live while exposing %s underneath', target => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const animations: Animation[] = [];
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => {
      const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
      animations.push(animation); return animation;
    } });
    function Shortcut() {
      const actual = useLocation(); const navigate = useNavigate();
      const transition = useWorkspaceRouteMotion(actual, true, -1, true);
      return <><button onClick={() => navigate(target, target === '/' ? undefined : { state: { navigationTab: true } })}>Return home</button>
        <button onClick={() => navigate('/downloads?changed=true', { replace: true })}>Change query</button>
        <section ref={transition.surface}>{transition.location.pathname}</section>
        <span data-testid="preview">{transition.previewLocation?.pathname}</span></>;
    }
    try {
      render(<MemoryRouter initialEntries={[{ pathname: '/downloads', state: { homeEntry: true } }]}><Shortcut /></MemoryRouter>);
      fireEvent.click(screen.getByText('Change query'));
      fireEvent.click(screen.getByText('Return home'));
      expect(screen.getByText('/downloads')).toHaveAttribute('data-page-return');
      expect(screen.getByTestId('preview')).toHaveTextContent(target);
      act(() => vi.advanceTimersByTime(20));
      act(() => animations.at(-1)?.onfinish?.(new Event('finish') as AnimationPlaybackEvent));
      expect(screen.queryByText('/downloads')).not.toBeInTheDocument();
      expect(document.querySelector('[data-page-return], [inert]')).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'animate', descriptor);
    }
  });
});

it('resets the detail scroll before entry animation and preserves the split list', () => {
  const view = (detailKey: string) => <div className="workspace">
    <RetainedPage active detailKey={detailKey}>
      <section className="library-shell-list" />
      <section className="library-shell-detail" />
    </RetainedPage>
  </div>;
  const { container, rerender } = render(view('server-a:archive-a'));
  const workspace = container.querySelector<HTMLElement>('.workspace')!;
  const detail = container.querySelector<HTMLElement>('.library-shell-detail')!;
  const list = container.querySelector<HTMLElement>('.library-shell-list')!;
  detail.scrollTop = 540;
  workspace.scrollTop = 320;
  list.scrollTop = 180;
  rerender(view('server-a:archive-a'));
  expect(detail.scrollTop).toBe(540);
  rerender(view('server-a:archive-b'));
  expect(workspace.scrollTop).toBe(0);
  expect(detail.scrollTop).toBe(0);
  expect(list.scrollTop).toBe(180);
});
