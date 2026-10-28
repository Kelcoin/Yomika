import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsMenu, SettingsNumber } from '../../src/components/SettingsValueControls';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('tracks natural menu growth and shrinkage without measuring the animated viewport', () => {
  let resize: ResizeObserverCallback = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  let height = 120;
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('settings-menu-content') ? height : 0;
  });
  const { unmount } = render(<SettingsMenu title="模型参数" onClose={() => {}}>参数</SettingsMenu>);
  const body = screen.getByRole('dialog').querySelector<HTMLElement>('.settings-menu-body')!;
  expect(body.style.height).toBe('120px');
  expect(observe).toHaveBeenCalledWith(body.firstElementChild);
  act(() => { height = 280; resize([], {} as ResizeObserver); });
  expect(body.style.height).toBe('280px');
  act(() => { height = 80; resize([], {} as ResizeObserver); });
  expect(body.style.height).toBe('80px');
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('uses the same back control for nested controls and restores the parent without closing it', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(<SettingsMenu title="模型设置" onClose={close}>
    <SettingsNumber label="强度" value={1} min={0} max={2} onChange={() => {}} />
  </SettingsMenu>);
  await user.click(screen.getByRole('button', { name: '强度' }));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: '强度' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '返回模型设置' }));
  expect(screen.getByRole('dialog', { name: '模型设置' })).toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '强度' }));
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog', { name: '模型设置' })).toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
});

it('returns one inline level on Escape and closes the menu on an outside click', async () => {
  const user = userEvent.setup();
  const back = vi.fn();
  const close = vi.fn();
  render(<SettingsMenu title="模型参数" onBack={back} onClose={close}>参数</SettingsMenu>);
  await user.keyboard('{Escape}');
  expect(back).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  const overlay = screen.getByRole('dialog').closest('.settings-choice-overlay')!;
  fireEvent.pointerDown(overlay);
  fireEvent.click(overlay);
  expect(close).toHaveBeenCalledOnce();
});
