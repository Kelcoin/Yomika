import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserRouter, Link, MemoryRouter, useLocation } from 'react-router-dom';
import { MOBILE_BACK_EVENT, PageBackHistory, usePageBackNavigation } from '../../src/lib/pageBackNavigation';
import { useState } from 'react';
import { useOverlayBackGuard } from '../../src/lib/overlayBackGuard';

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
  return <><p data-testid="route">{location.pathname}</p><Link to="/home/a">detail</Link><Link to="/library">library</Link><Link to="/settings" state={{ homeEntry: true }}>home settings</Link></>;
}
function back() { act(() => { window.dispatchEvent(new Event(MOBILE_BACK_EVENT, { cancelable: true })); }); }

afterEach(() => { delete document.documentElement.dataset.nativeMobile; });

it('handles Android Back without traversing global Router history', () => {
  render(<MemoryRouter><Navigation /></MemoryRouter>);
  fireEvent.click(screen.getByText('detail'));
  back();
  expect(screen.getByTestId('route')).toHaveTextContent(/^\/$/);
  fireEvent.click(screen.getByText('library'));
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
  back();
  expect(screen.queryByText('open menu')).toBeNull();
  expect(screen.getByTestId('route')).toHaveTextContent('/home/a');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  back();
  expect(screen.getByTestId('route')).toHaveTextContent(/^\/$/);
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
