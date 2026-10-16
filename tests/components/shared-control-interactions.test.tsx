import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DatePicker } from '../../src/components/DatePicker';
import { SelectField } from '../../src/components/SelectField';
import { TextInputDialog } from '../../src/components/TextInputDialog';
import { SearchPresetField } from '../../src/components/SearchPresetField';
import { SettingsMenu } from '../../src/components/SettingsValueControls';
import { RetainedPage } from '../../src/app/RetainedPage';

function SelectHarness() {
  const [value, setValue] = useState('a');
  return <><SelectField name="sort" value={value} onChange={setValue}
    options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]} /><button>Outside</button></>;
}

describe('shared control keyboard and focus behavior', () => {
  it('retires a settings sheet and its keyboard listener when its retained page hides', () => {
    const close = vi.fn();
    function Owner({ active }: { active: boolean }) {
      const [open, setOpen] = useState(true);
      return <RetainedPage active={active}>{open && <SettingsMenu title="Retained settings" onClose={() => { close(); setOpen(false); }}><button>Sheet action</button></SettingsMenu>}</RetainedPage>;
    }
    const { rerender } = render(<Owner active />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(<Owner active={false} />);
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    rerender(<Owner active />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['preset', 'select', 'calendar'] as const)('closes a %s when its retained page becomes inactive', async (kind) => {
    const content = kind === 'preset' ? <SearchPresetField onApply={vi.fn()} onSave={vi.fn()} />
      : kind === 'select' ? <SelectHarness /> : <DatePicker label="日期" value="2026-10-15" onChange={vi.fn()} />;
    const { rerender } = render(<RetainedPage active>{content}</RetainedPage>);
    const trigger = screen.getByRole('button', { name: kind === 'preset' ? '检索预设' : kind === 'select' ? 'Alpha' : '日期' });
    fireEvent.click(trigger);
    const role = kind === 'preset' ? 'menu' : kind === 'select' ? 'listbox' : 'dialog';
    expect(screen.getByRole(role)).toBeInTheDocument();
    rerender(<RetainedPage active={false}>{content}</RetainedPage>);
    expect(screen.queryByRole(role, { hidden: true })).not.toBeInTheDocument();
    rerender(<RetainedPage active>{content}</RetainedPage>);
    expect(screen.queryByRole(role)).not.toBeInTheDocument();
  });

  it('scrolls a long select to keyboard choices and accepts the choice with Enter', () => {
    function LongSelect() {
      const [value, setValue] = useState('0');
      return <SelectField name="long" value={value} onChange={setValue}
        options={Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: `Choice ${index}` }))} />;
    }
    render(<LongSelect />);
    const trigger = screen.getByRole('button', { name: 'Choice 0' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('listbox');
    Object.defineProperty(menu, 'clientHeight', { configurable: true, value: 80 });
    const options = menu.querySelectorAll('[role="option"]');
    options.forEach((option, index) => {
      Object.defineProperty(option, 'offsetTop', { configurable: true, value: index * 40 });
      Object.defineProperty(option, 'offsetHeight', { configurable: true, value: 40 });
    });
    fireEvent.keyDown(trigger, { key: 'End' });
    expect(trigger).toHaveTextContent('Choice 11');
    expect(menu.scrollTop).toBe(400);
    fireEvent.keyDown(trigger, { key: 'Home' });
    expect(menu.scrollTop).toBe(0);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps keyboard focus inside a settings menu and returns it when closed', async () => {
    const user = userEvent.setup();
    function Menu() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open settings</button>{open && <SettingsMenu title="Modal settings" onClose={() => setOpen(false)}><button>First action</button><button>Last action</button></SettingsMenu>}<button>Outside action</button></>;
    }
    render(<Menu />);
    const trigger = screen.getByRole('button', { name: 'Open settings' });
    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'First action' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Last action' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'First action' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes an inner select before its settings menu and restores focus through nested menus', async () => {
    const user = userEvent.setup();
    function Menus() {
      const [inner, setInner] = useState(false);
      return <SettingsMenu title="Outer" onClose={vi.fn()}><button onClick={() => setInner(true)}>Open inner</button>{inner && <SettingsMenu title="Inner" onClose={() => setInner(false)}><SelectHarness /></SettingsMenu>}</SettingsMenu>;
    }
    render(<Menus />);
    const opener = screen.getByRole('button', { name: 'Open inner' });
    await user.click(opener);
    const select = screen.getByRole('button', { name: 'Alpha' });
    await user.click(select);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Inner' })).toBeInTheDocument();
    expect(select).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Inner' })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('restores select trigger focus after selecting and closes when tabbing out of the menu', async () => {
    const user = userEvent.setup();
    render(<SelectHarness />);
    const trigger = screen.getByRole('button', { name: 'Alpha' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Beta' }));
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(trigger);
    await user.tab();
    await user.tab();
    expect(screen.getAllByRole('button', { name: 'Beta' }).at(-1)).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('handles Escape from inside an option and keeps Home/End navigation open', async () => {
    const user = userEvent.setup();
    render(<SelectHarness />);
    const trigger = screen.getByRole('button', { name: 'Alpha' });
    await user.click(trigger);
    await user.keyboard('{End}');
    expect(trigger).toHaveTextContent('Beta');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.tab();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes the calendar with Escape from a day button and returns focus', async () => {
    const user = userEvent.setup();
    render(<DatePicker label="开始日期" value="2026-10-15" onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '开始日期' });
    await user.click(trigger);
    screen.getByRole('button', { name: '15' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('fits a calendar near the right and bottom edges and returns focus after selection', async () => {
    const user = userEvent.setup();
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 220, right: 300, top: 600, bottom: 660, width: 80, height: 60, x: 220, y: 600, toJSON: () => ({}),
    });
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(310);
    const viewport = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(320);
    const onChange = vi.fn();
    try {
      render(<DatePicker label="结束日期" value="2026-10-15" onChange={onChange} />);
      const trigger = screen.getByRole('button', { name: '结束日期' });
      await user.click(trigger);
      expect(screen.getByRole('dialog')).toHaveStyle({ left: '-192px', bottom: 'calc(100% + 6px)', width: '280px' });
      await user.click(screen.getByRole('button', { name: '16' }));
      expect(onChange).toHaveBeenCalledWith('2026-10-16');
      expect(trigger).toHaveFocus();
    } finally {
      rect.mockRestore(); height.mockRestore(); viewport.mockRestore();
    }
  });

  it('does not confirm a text dialog when Enter completes IME composition', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<TextInputDialog open title="重命名" label="名称" defaultValue="中文" onConfirm={onConfirm} onOpenChange={onOpenChange} />);
    const input = screen.getByRole('textbox', { name: '名称' });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith('中文');
  });

  it('validates the trimmed value that will actually be submitted', () => {
    render(<TextInputDialog open title="重命名" label="名称" defaultValue="  " validate={(value) => value ? undefined : '名称不能为空'} onConfirm={vi.fn()} onOpenChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '确定' })).toBeDisabled();
  });

  it('focuses the preset menu and restores its trigger after Escape', async () => {
    const user = userEvent.setup();
    render(<SearchPresetField onApply={vi.fn()} onSave={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '检索预设' });
    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: '新增预设' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('calls the settings close handler once for Escape in a child control', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsMenu title="设置" onClose={onClose}><input aria-label="设置值" /></SettingsMenu>);
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
