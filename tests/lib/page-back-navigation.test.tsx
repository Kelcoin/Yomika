import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserRouter, Link, MemoryRouter, useLocation } from 'react-router-dom';
import { MOBILE_BACK_EVENT, PageBackHistory, usePageBackNavigation } from '../../src/lib/pageBackNavigation';
import { useReturnNavigation } from '../../src/lib/useReturnNavigation';
import { useState } from 'react';
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

function StagedPages() {
  usePageBackNavigation();
  const location = useLocation();
  const home = location.pathname === '/' || location.pathname.startsWith('/home/');
  return (
    <div className="workspace">
      <section className="route-cache-panel" data-page-key="/" hidden={!home}><p>home page</p></section>
      <section className="route-cache-panel" data-page-key="/settings" hidden={location.pathname !== '/settings'}><p data-testid="stage-route">{location.pathname}</p></section>
    </div>
  );
}

it('reveals the page behind an iOS edge swipe and hands it to the return animation', async () => {
  document.documentElement.dataset.nativePlatform = 'ios';
  render(<MemoryRouter initialEntries={['/']}><StagedPages /><Link to="/settings" state={{ homeEntry: true }}>home settings</Link></MemoryRouter>);
  fireEvent.click(screen.getByText('home settings'));
  const home = document.querySelector<HTMLElement>('.route-cache-panel[data-page-key="/"]')!;
  const settings = document.querySelector<HTMLElement>('.route-cache-panel[data-page-key="/settings"]')!;
  expect(home.hidden).toBe(true);
  const start = { identifier: 1, clientX: 10, clientY: 300 };
  const move = { identifier: 1, clientX: 120, clientY: 306 };
  fireEvent.touchStart(document.body, { touches: [start] });
  fireEvent.touchMove(document.body, { touches: [move] });
  // The layer behind the drag is the real page, pinned under the sliding one.
  expect(home.hidden).toBe(false);
  expect(home.hasAttribute('data-back-preview')).toBe(true);
  expect(home.getAttribute('aria-hidden')).toBe('true');
  expect(settings.style.translate).toBe('110px');
  expect(parseFloat(home.style.translate)).toBeLessThan(-200);
  fireEvent.touchEnd(document.body, { touches: [], changedTouches: [move] });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(screen.getByTestId('stage-route')).toHaveTextContent(/^\/$/);
  // A handled Back keeps the revealed page on screen for the route animation;
  // only the drag's own inline styles and the preview bookkeeping go away.
  expect(home.hidden).toBe(false);
  expect(home.hasAttribute('data-back-preview')).toBe(false);
  expect(home.style.translate).toBe('');
  expect(settings.style.translate).toBe('');
});

it('hides the revealed page again when the iOS edge swipe is too short', async () => {
  document.documentElement.dataset.nativePlatform = 'ios';
  render(<MemoryRouter initialEntries={['/']}><StagedPages /><Link to="/settings" state={{ homeEntry: true }}>home settings</Link></MemoryRouter>);
  fireEvent.click(screen.getByText('home settings'));
  const home = document.querySelector<HTMLElement>('.route-cache-panel[data-page-key="/"]')!;
  const start = { identifier: 1, clientX: 10, clientY: 300 };
  const move = { identifier: 1, clientX: 40, clientY: 302 };
  fireEvent.touchStart(document.body, { touches: [start] });
  fireEvent.touchMove(document.body, { touches: [move] });
  expect(home.hidden).toBe(false);
  fireEvent.touchEnd(document.body, { touches: [], changedTouches: [move] });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(screen.getByTestId('stage-route')).toHaveTextContent('/settings');
  expect(home.hidden).toBe(true);
  expect(home.hasAttribute('data-back-preview')).toBe(false);
});
