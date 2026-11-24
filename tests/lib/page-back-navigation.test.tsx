import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserRouter, Link, MemoryRouter, useLocation } from 'react-router-dom';
import { IOS_BACK_PREVIEW, MOBILE_BACK_EVENT, PageBackHistory, usePageBackNavigation } from '../../src/lib/pageBackNavigation';
import { useReturnNavigation } from '../../src/lib/useReturnNavigation';
import { useLayoutEffect, useState } from 'react';
import { resolveRouteMotion } from '../../src/lib/routeMotion';
import { useOverlayBackGuard } from '../../src/lib/overlayBackGuard';
import { useRouteDirection } from '../../src/lib/useRouteDirection';

describe('workspace-scoped Back', () => {
  it('never returns from one tab to another, including root gestures', () => {
    const history = new PageBackHistory();
    history.visit('/'); history.visit('/home/a');
    history.visit('/library'); history.visit('/library/b');
    expect(history.back()).toBe('/library');
    expect(history.back()).toBeUndefined();
    history.visit('/home/a');
    expect(history.back()).toBe('/');
    expect(history.back()).toBeUndefined();
  });
  it('returns home after a shortcut excursion and clears that origin for bottom tabs', () => {
    const history = new PageBackHistory();
    history.visit('/');
    history.visit('/history', undefined, true);
    history.visit('/history/a');
    expect(history.back()).toBe('/history');
    history.visit('/history');
    expect(history.back()).toBe('/');
    history.visit('/');
    history.visit('/history', undefined, false, true);
    expect(history.back()).toBeUndefined();
    history.visit('/');
    history.visit('/downloads', undefined, true);
    history.visit('/library', undefined, false, true);
    history.visit('/downloads', undefined, false, true);
    expect(history.back()).toBeUndefined();
  });
  it('drops the entries ahead when a page is visited again', () => {
    // Going back and then opening something else must not leave the abandoned
    // page reachable: Back would jump to a URL the user has already left.
    const history = new PageBackHistory();
    history.visit('/library'); history.visit('/library/b'); history.visit('/library');
    expect(history.back()).toBeUndefined();
    history.visit('/library/c');
    expect(history.back()).toBe('/library');
  });
  it('keeps readers and metadata editors with the page that opened them', () => {
    const history = new PageBackHistory();
    history.visit('/'); history.visit('/home/a');
    history.visit('/library/a/edit', '/home/a');
    expect(history.back()).toBe('/home/a');
    history.visit('/reader/a');
    expect(history.back()).toBe('/home/a');
    expect(history.back()).toBe('/');
    history.visit('/tools/dedup');
    expect(history.back()).toBe('/more');
  });
});

function Navigation() {
  usePageBackNavigation();
  const location = useLocation();
  const direction = useRouteDirection();
  return <><output data-testid="direction">{direction}</output><p data-testid="route">{location.pathname}</p><Link to="/home/a">detail</Link><Link to="/library">library</Link><Link to="/settings" state={{ homeEntry: true }}>home settings</Link></>;
}
function back() {
  let unhandled = false;
  act(() => { unhandled = window.dispatchEvent(new Event(MOBILE_BACK_EVENT, { cancelable: true })); });
  return unhandled;
}

afterEach(() => { delete document.documentElement.dataset.nativeMobile; delete document.documentElement.dataset.nativePlatform; });

it.each(['/', '/library', '/history', '/watchlist', '/to-read', '/downloads', '/settings'])('leaves root Back on %s to the native host', path => {
  render(<MemoryRouter initialEntries={[path]}><Navigation /></MemoryRouter>);
  expect(back()).toBe(true);
  expect(screen.getByTestId('route')).toHaveTextContent(path);
});

it('consumes a detail return, then hands the next root gesture to the host', () => {
  render(<MemoryRouter initialEntries={['/home/a']}><Navigation /></MemoryRouter>);
  expect(back()).toBe(false);
  expect(screen.getByTestId('route')).toHaveTextContent(/^\/$/);
  expect(back()).toBe(true);
});

it('handles Android Back without traversing global Router history', () => {
  render(<MemoryRouter><Navigation /></MemoryRouter>);
  fireEvent.click(screen.getByText('detail'));
  expect(screen.getByTestId('direction')).toHaveTextContent('1');
  back();
  expect(screen.getByTestId('route')).toHaveTextContent(/^\/$/);
  expect(screen.getByTestId('direction')).toHaveTextContent('-1');
  fireEvent.click(screen.getByText('library'));
  expect(screen.getByTestId('direction')).toHaveTextContent('1');
  back();
  expect(screen.getByTestId('route')).toHaveTextContent('/library');
});

it('intercepts mobile browser POP before it crosses into another tab', () => {
  document.documentElement.dataset.nativeMobile = 'true';
  window.history.replaceState({}, '', '/');
  render(<BrowserRouter><Navigation /></BrowserRouter>);
  fireEvent.click(screen.getByText('detail'));
  fireEvent.click(screen.getByText('library'));
  act(() => {
    // A WebView swipe landed on the other tab's old detail URL.
    window.history.replaceState({}, '', '/home/a');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(screen.getByTestId('route')).toHaveTextContent('/library');
  expect(window.location.pathname).toBe('/library');
});

it('closes a native overlay first and returns the route on the following gesture', async () => {
  function Overlay() {
    const [open, setOpen] = useState(true);
    useOverlayBackGuard(open, () => setOpen(false));
    return open ? <p>open menu</p> : null;
  }
  render(<MemoryRouter initialEntries={['/home/a']}><Navigation /><Overlay /></MemoryRouter>);
  expect(back()).toBe(false);
  expect(screen.queryByText('open menu')).toBeNull();
  expect(screen.getByTestId('route')).toHaveTextContent('/home/a');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(back()).toBe(false);
  expect(screen.getByTestId('route')).toHaveTextContent(/^\/$/);
  expect(back()).toBe(true);
});


it('returns to home from a shortcut using the native back action', () => {
  render(<MemoryRouter><Navigation /></MemoryRouter>);
  fireEvent.click(screen.getByText('home settings'));
  expect(screen.getByTestId('route')).toHaveTextContent('/settings');
  back();
  expect(screen.getByTestId('route')).toHaveTextContent(/^\/$/);
});


it('preserves home shortcut origin when mobile browser POP is intercepted', () => {
  document.documentElement.dataset.nativeMobile = 'true';
  window.history.replaceState({}, '', '/');
  render(<BrowserRouter><Navigation /></BrowserRouter>);
  fireEvent.click(screen.getByText('home settings'));
  act(() => {
    window.history.replaceState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(screen.getByTestId('route')).toHaveTextContent(/^\/$/);
  expect(window.location.pathname).toBe('/');
});


it('uses an iOS edge swipe for page-scoped Back without taking vertical or interior swipes', () => {
  document.documentElement.dataset.nativePlatform = 'ios';
  render(<MemoryRouter initialEntries={['/home/a']}><Navigation /></MemoryRouter>);
  const swiping = (from: number, dx: number, dy: number) => {
    const start = { identifier: 1, clientX: from, clientY: 100 };
    const end = { identifier: 1, clientX: from + dx, clientY: 100 + dy };
    fireEvent.touchStart(document.body, { touches: [start] });
    fireEvent.touchMove(document.body, { touches: [end] });
    fireEvent.touchEnd(document.body, { touches: [], changedTouches: [end] });
  };
  swiping(40, 100, 0);
  swiping(10, 45, 90);
  expect(screen.getByTestId('route')).toHaveTextContent('/home/a');
  swiping(10, 100, 10);
  expect(screen.getByTestId('route')).toHaveTextContent(/^\/$/);
});

function NestedDetailNavigation() {
  usePageBackNavigation();
  const { pathname } = useLocation();
  const goBack = useReturnNavigation();
  return <><output>{pathname}</output><Link to="/library/a">first</Link>
    <Link to="/library/b" state={{ returnTo: '/library' }}>second</Link>
    <button onClick={goBack}>back button</button></>;
}

it('uses the same workspace history for the detail back button and gesture', () => {
  render(<MemoryRouter initialEntries={['/library']}><NestedDetailNavigation /></MemoryRouter>);
  fireEvent.click(screen.getByText('first'));
  fireEvent.click(screen.getByText('second'));
  fireEvent.click(screen.getByText('back button'));
  expect(screen.getByRole('status')).toHaveTextContent('/library/a');
  expect(back()).toBe(false);
  expect(screen.getByRole('status')).toHaveTextContent(/^\/library$/);
});

function GesturePages() {
  usePageBackNavigation();
  const location = useLocation();
  const [target, setTarget] = useState<string>();
  useLayoutEffect(() => {
    const stage = (event: Event) => setTarget((event as CustomEvent<string | undefined>).detail);
    document.addEventListener(IOS_BACK_PREVIEW, stage);
    return () => document.removeEventListener(IOS_BACK_PREVIEW, stage);
  }, []);
  return <div className="app-shell">
    <div className="app-main"><main id="main-content" className="workspace">
      <output data-testid="stage-route">{location.pathname}</output>
      <output data-testid="route-motion">{resolveRouteMotion({ pathname: '/library/b', search: '' }, location, true, -1).kind}</output>
      <Link to="/library/a">first detail</Link><Link to="/library/b">second detail</Link>
    </main></div>
    {target && <div data-ios-back-preview="" aria-hidden="true">{target}</div>}
  </div>;
}

it.each([true, false])('settles the same detail-to-detail layers before swapping routes (commit=%s)', commit => {
  document.documentElement.dataset.nativePlatform = 'ios';
  render(<MemoryRouter initialEntries={['/library']}><GesturePages /></MemoryRouter>);
  fireEvent.click(screen.getByText('first detail'));
  fireEvent.click(screen.getByText('second detail'));
  const foreground = document.querySelector<HTMLElement>('.app-main')!;
  let playback: { onfinish?: () => void; cancel: () => void } | undefined;
  foreground.animate = frames => {
    expect(frames).toEqual([{ translate: commit ? '110px' : '32px' }, { translate: commit ? `${window.innerWidth}px` : '0px' }]);
    playback = { cancel() {} };
    return playback as unknown as Animation;
  };
  const start = { identifier: 1, clientX: 10, clientY: 300 };
  const move = { ...start, clientX: commit ? 120 : 42 };
  fireEvent.touchStart(document.body, { touches: [start] });
  fireEvent.touchMove(document.body, { touches: [move] });
  expect(document.querySelector('[data-ios-back-preview]')).toHaveTextContent('/library/a');
  fireEvent.touchEnd(document.body, { touches: [], changedTouches: [move] });
  expect(screen.getByTestId('stage-route')).toHaveTextContent('/library/b');
  expect(foreground.style.translate).toBe(commit ? '110px' : '32px');
  act(() => playback?.onfinish?.());
  expect(screen.getByTestId('stage-route')).toHaveTextContent(commit ? '/library/a' : '/library/b');
  if (commit) expect(screen.getByTestId('route-motion')).toHaveTextContent('none');
  expect(foreground.style.translate).toBe('');
  expect(foreground.hasAttribute('data-ios-back-foreground')).toBe(false);
  expect(document.querySelector('[data-ios-back-preview]')).toBeNull();
});
