import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { SettingsNumber } from '../../src/components/SettingsValueControls';
import * as haptics from '../../src/lib/haptics';

beforeEach(() => { vi.spyOn(haptics, 'hapticFeedback').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());
function Harness({ initial = 1.1, step = 0.1, min = 0, max = 2 }: { initial?: number; step?: number; min?: number; max?: number }) {
  const [value, setValue] = useState(initial);
  return <SettingsNumber label="局部色调" value={value} min={min} max={max} step={step} format={(value) => `${value} 倍`} onChange={setValue} />;
}
async function open() {
  await userEvent.click(screen.getByRole('button', { name: '局部色调' }));
  return screen.getByRole('slider', { name: '局部色调' });
}
describe('numeric slider', () => {
  it('snaps to decimal steps without binary residue and displays the formatted value', async () => {
    render(<Harness />);
    const slider = await open();
    fireEvent.change(slider, { target: { value: '1.23' } });
    expect(slider).toHaveValue('1.2');
    expect(slider).toHaveAttribute('aria-valuetext', '1.2 倍');
    expect(haptics.hapticFeedback).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: '1.31' } });
    expect(slider).toHaveValue('1.3');
  });
  it('retains bounds and anchors integer steps at a nonzero minimum', async () => {
    render(<Harness initial={128} min={64} max={8192} step={64} />);
    const slider = await open();
    fireEvent.change(slider, { target: { value: '200' } });
    expect(slider).toHaveValue('192');
    fireEvent.change(slider, { target: { value: '9000' } });
    expect(slider).toHaveValue('8192');
    fireEvent.change(slider, { target: { value: '0' } });
    expect(slider).toHaveValue('64');
  });
  it('limits vibration to distinct touch steps and does not dismiss after dragging outside', async () => {
    render(<Harness />);
    const slider = await open();
    vi.spyOn(performance, 'now').mockReturnValue(100);
    // jsdom does not implement PointerEvent, so provide pointerType explicitly.
    const down = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(down, 'pointerType', { value: 'touch' });
    fireEvent(slider, down);
    fireEvent.change(slider, { target: { value: '1.2' } });
    fireEvent.change(slider, { target: { value: '1.3' } });
    expect(haptics.hapticFeedback).toHaveBeenCalledTimes(1);
    vi.mocked(performance.now).mockReturnValue(160);
    fireEvent.change(slider, { target: { value: '1.4' } });
    expect(haptics.hapticFeedback).toHaveBeenCalledTimes(2);
    const overlay = slider.closest('.settings-choice-overlay')!;
    fireEvent.pointerUp(overlay);
    fireEvent.click(overlay);
    expect(slider).toBeInTheDocument();
  });
  it('keeps disabled settings closed', async () => {
    render(<SettingsNumber label="局部色调" value={1} min={0} max={2} onChange={vi.fn()} disabled />);
    await userEvent.click(screen.getByText('局部色调'));
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
