import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/components/AppShell';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';

const preference = vi.hoisted(() => ({ floating: true }));
vi.mock('../../src/app/preferences', () => ({ usePreferences: () => ({ preferences: { ...DEFAULT_PREFERENCES, floatingNav: preference.floating } }) }));
vi.mock('../../src/components/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('../../src/components/TitleBar', () => ({ TitleBar: () => null }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}:{String(location.state?.navigationTab)}</output>;
}

it.each([{ floating: true, type: 'touch' }, { floating: false, type: 'mouse' }])('commits one router tab change for a $type drag (floating=$floating)', async ({ floating, type }) => {
  preference.floating = floating;
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: !query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} })));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const links = this.closest('nav')?.querySelectorAll('[data-nav-route]');
    const index = links ? Array.from(links).indexOf(this) : -1;
    const left = Math.max(0, index) * 100;
    return { left, right: left + 100, top: 0, bottom: 60, x: left, y: 0, width: 100, height: 60, toJSON() {} };
  });
  render(<MemoryRouter><AppShell><Location /></AppShell></MemoryRouter>);
  const nav = screen.getByRole('navigation', { name: '移动导航' });
  const home = within(nav).getByRole('link', { name: '首页' });
  const pointer = (name: string, clientX: number) => {
    const event = new Event(name, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: type, button: 0, clientX, clientY: 30, isPrimary: true });
    fireEvent(home, event);
  };
  pointer('pointerdown', 50);
  pointer('pointermove', 155);
  expect(screen.getByTestId('location')).toHaveTextContent('/:undefined');
  pointer('pointerup', 155);
  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/library:true'));
  expect(fireEvent.click(home, { detail: 1 })).toBe(false);
  expect(screen.getByTestId('location')).toHaveTextContent('/library:true');
  expect(within(nav).getByRole('link', { name: '档案库' })).toHaveAttribute('aria-current', 'page');
});
