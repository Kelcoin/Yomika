import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TitleBar } from '../../src/components/TitleBar';
import * as Dialog from '@radix-ui/react-dialog';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('Windows title bar', () => {
  it('keeps a menu open when pressing the title surface or window controls', async () => {
    const view = render(<><TitleBar /><Dialog.Root defaultOpen><Dialog.Portal>
      <Dialog.Overlay data-testid="backdrop" />
      <Dialog.Content aria-describedby={undefined}><Dialog.Title>Menu</Dialog.Title></Dialog.Content>
    </Dialog.Portal></Dialog.Root></>);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    fireEvent.pointerDown(view.container.querySelector('.titlebar')!, { pointerType: 'mouse', button: 0 });
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
    fireEvent.pointerDown(view.container.querySelector('.titlebar-control')!, { pointerType: 'mouse', button: 0 });
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId('backdrop'), { pointerType: 'mouse', button: 0 });
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });
  it('starts a native drag from the title surface without dragging controls', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
    render(<TitleBar />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.mouseDown(screen.getByRole('banner'), { button: 0, detail: 1 });
    expect(invoke).toHaveBeenCalledWith('plugin:window|start_dragging', { label: 'main' });
    invoke.mockClear();
    fireEvent.mouseDown(screen.getByRole('button', { name: '关闭' }), { button: 0, detail: 1 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('coalesces resize checks while the window is being resized', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue(false);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
    render(<TitleBar />);
    await act(async () => { await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledTimes(1);

    act(() => {
      for (let index = 0; index < 20; index += 1) fireEvent.resize(window);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(120); await Promise.resolve(); });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
