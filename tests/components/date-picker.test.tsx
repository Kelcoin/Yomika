import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DatePicker } from '../../src/components/DatePicker';

it('centers the calendar on its trigger and clamps it within the viewport', () => {
  const view = render(<DatePicker label="开始日期" value="2026-10-21" onChange={vi.fn()} />);
  const trigger = screen.getByRole('button', { name: '开始日期' });
  const root = trigger.parentElement!;
  const rect = (left: number, width: number) => ({ left, width, right: left + width, top: 50, bottom: 90, height: 40, x: left, y: 50, toJSON() {} });
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(200, 120));
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(200, 120));
  fireEvent.click(trigger);
  const calendar = screen.getByRole('dialog');
  expect(calendar.style.left).toBe('-80px');
  vi.mocked(root.getBoundingClientRect).mockReturnValue(rect(20, 120));
  vi.mocked(trigger.getBoundingClientRect).mockReturnValue(rect(20, 120));
  fireEvent(window, new Event('resize'));
  expect(calendar.style.left).toBe('-8px');
  view.unmount();
});
