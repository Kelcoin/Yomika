import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { DialogSurface, DialogHeading } from '../../src/components/DialogSurface';
import { PositionedMenu } from '../../src/components/PositionedMenu';
import { SettingsOption } from '../../src/components/SettingsValueControls';

it('preserves dialog names, custom classes, refs and autofocus hooks', () => {
  const ref = createRef<HTMLDivElement>();
  const focus = vi.fn((event: Event) => event.preventDefault());
  render(<Dialog.Root open><DialogSurface ref={ref} className="custom-surface" onOpenAutoFocus={focus}>
    <DialogHeading hidden>确认操作</DialogHeading><Dialog.Description>说明</Dialog.Description>
  </DialogSurface></Dialog.Root>);
  expect(screen.getByRole('dialog', { name: '确认操作' })).toBe(ref.current);
  expect(ref.current).toHaveClass('dialog-content', 'custom-surface');
  expect(screen.getByText('确认操作')).toHaveClass('visually-hidden');
  expect(focus).toHaveBeenCalledOnce();
});

it('keeps row actions available independently of a disabled selection', async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  const download = vi.fn();
  render(<SettingsOption disabled onClick={select} action={<button onClick={download}>下载</button>} status={<span>下载进度</span>}>模型</SettingsOption>);
  await user.click(screen.getByRole('button', { name: '模型' }));
  await user.click(screen.getByRole('button', { name: '下载' }));
  expect(select).not.toHaveBeenCalled();
  expect(download).toHaveBeenCalledOnce();
  expect(screen.getByText('下载进度')).toBeInTheDocument();
});

it('opens pointer menus without locking body scrolling and closes on item selection', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const select = vi.fn();
  const overflow = document.body.style.overflow;
  render(<PositionedMenu at={{ x: 25, y: 50 }} label="档案操作" onClose={close}>
    <DropdownMenu.Item onSelect={select}>打开</DropdownMenu.Item>
  </PositionedMenu>);
  expect(screen.getByRole('menu', { name: '档案操作' })).toBeInTheDocument();
  expect(document.body.style.overflow).toBe(overflow);
  await user.click(screen.getByRole('menuitem', { name: '打开' }));
  expect(select).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
