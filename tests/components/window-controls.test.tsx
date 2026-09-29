import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TitleBar } from '../../src/components/TitleBar';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('Windows title bar', () => {
  it('keeps the brand mark inside the draggable region', () => {
    render(<TitleBar />);
    expect(screen.getByRole('banner')).toHaveAttribute('data-tauri-drag-region', 'deep');
    expect(screen.getByRole('button', { name: '关闭' }).parentElement).toHaveAttribute('data-tauri-drag-region', 'false');
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
