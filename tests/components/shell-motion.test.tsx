import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/components/AppShell';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
vi.mock('../../src/app/preferences', () => ({ usePreferences: () => ({ preferences: { ...DEFAULT_PREFERENCES, floatingNav: true } }) }));
afterEach(() => vi.restoreAllMocks());
function renderShell() {
  render(<MemoryRouter><AppShell><div data-testid="content">Content</div><input aria-label="Editor" /><div data-testid="nested" style={{ overflowY: 'auto' }}>Nested</div><div className="library-workspace">Library</div></AppShell></MemoryRouter>);
  const host = document.getElementById('main-content')!;
  host.style.overflowY = 'auto';
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 500 }, scrollHeight: { configurable: true, value: 1000 } });
  return host;
}
it('places the top button alongside a measured floating bar only when it fits', () => {
  let right = 300;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const nav = this.classList.contains('compact-nav');
    return { left: nav ? 100 : 0, right: nav ? right : 44, top: nav ? 700 : 0, bottom: nav ? 764 : 44, width: nav ? right - 100 : 44, height: nav ? 64 : 44 } as DOMRect;
  });
  renderShell();
  const button = screen.getByRole('button', { name: '返回顶部' });
  expect(button).toHaveAttribute('data-placement', 'beside');
  right = window.innerWidth - 30;
  fireEvent(window, new Event('resize'));
  expect(button).toHaveAttribute('data-placement', 'above');
});
it('damps only outward edge touches, resets on return and cancel, and leaves editors and nested regions alone', () => {
  const host = renderShell();
  const drag = (target: Element, y: number, x = 0) => fireEvent.touchMove(target, { touches: [{ clientY: y, clientX: x }] });
  const start = (target: Element) => fireEvent.touchStart(target, { touches: [{ clientY: 10, clientX: 0 }] });
  start(host); drag(host, 110);
  expect(screen.getByTestId('content').style.top).toBe('50px');
  drag(host, 10);
  expect(screen.getByTestId('content').style.top).toBe('0px');
  fireEvent.touchCancel(host);
  expect(screen.getByTestId('content').style.top).toBe('');
  start(host); drag(host, 20, 100);
  expect(screen.getByTestId('content').style.top).toBe('');
  for (const target of [screen.getByRole('textbox'), screen.getByTestId('nested'), screen.getByText('Library')]) {
    start(target); drag(target, 110); expect(screen.getByTestId('content').style.top).toBe('');
  }
  host.scrollTop = 200; start(host); drag(host, 110); expect(screen.getByTestId('content').style.top).toBe('');
  host.scrollTop = 500; start(host); drag(host, -90); expect(screen.getByTestId('content').style.top).toBe('-50px');
  fireEvent.touchEnd(host); expect(screen.getByTestId('content').style.top).toBe('0px');
  expect(host.style.transform).toBe(''); expect(host.style.translate).toBe('');
});

it('uses a vertical overflow:auto region even when both computed axes are auto', () => {
  render(<MemoryRouter><AppShell><section data-scroll-region style={{ overflowX: 'auto', overflowY: 'auto' }}><div data-testid="vertical-content">Vertical</div></section></AppShell></MemoryRouter>);
  const content = screen.getByTestId('vertical-content');
  const region = content.parentElement!;
  Object.defineProperties(region, { clientHeight: { value: 500 }, scrollHeight: { value: 1000 }, clientWidth: { value: 300 }, scrollWidth: { value: 300 } });
  fireEvent.touchStart(content, { touches: [{ clientY: 10, clientX: 0 }] });
  fireEvent.touchMove(content, { touches: [{ clientY: 110, clientX: 0 }] });
  expect(content.style.top).toBe('50px');
  expect(region.style.transform).toBe('');
  fireEvent.touchCancel(content);
  expect(content.style.top).toBe('');
});

it('remeasures the nav after a hide/show transform transition without resize', () => {
  let top = 700;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const nav = this.classList.contains('compact-nav');
    return { left: nav ? 100 : 0, right: nav ? 300 : 44, top: nav ? top : 0, bottom: nav ? top + 64 : 44, width: nav ? 200 : 44, height: nav ? 64 : 44 } as DOMRect;
  });
  const host = renderShell();
  const button = screen.getByRole('button', { name: '返回顶部' });
  const nav = screen.getByRole('navigation', { name: '移动导航' });
  host.scrollTop = 100; fireEvent.scroll(host);
  expect(nav).toHaveClass('is-hidden');
  top = 800; // The bar has not returned to its settled visible rect yet.
  host.scrollTop = 50; fireEvent.scroll(host);
  expect(nav).not.toHaveClass('is-hidden');
  const transient = button.style.bottom;
  top = 700;
  fireEvent.transitionEnd(nav, { propertyName: 'transform' });
  expect(button.style.bottom).not.toBe(transient);
  expect(button.style.bottom).toBe(`${window.innerHeight - 732 - 22}px`);
});
