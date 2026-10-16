import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TagSuggest } from '../../src/components/TagSuggest';
import { installTagTranslations } from '../../src/lib/tags';

/** 候选列表的真实来源是装好的译文库（不 mock：setup 会预加载用到它的组件）。 */
function Harness({ exact, onSelect }: { exact?: boolean; onSelect: (tag: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <input ref={ref} defaultValue="gla" aria-label="标签输入" />
      <TagSuggest inputValue="gla" anchorRef={ref} onSelect={onSelect} {...(exact === undefined ? {} : { exact })} />
    </div>
  );
}

describe('tag suggestions', () => {
  afterEach(() => { installTagTranslations({}); });

  it('adds the exact-query suffix by default, for the library search', async () => {
    // 库检索里 `female:glasses$` 才是「正好是这条」。
    installTagTranslations({ female: { glasses: '眼镜' } });
    const onSelect = vi.fn();
    render(<MemoryRouter><Harness onSelect={onSelect} /></MemoryRouter>);
    fireEvent.focus(screen.getByRole('combobox'));

    const option = await screen.findByRole('option');
    expect(option).toHaveTextContent('female:glasses$');
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith('female:glasses$');
  });

  it('adds the bare tag when the caller edits tags rather than queries', async () => {
    // 元数据编辑要的是标签本身：带上 `$` 等于存了一条别人认不出来的标签。
    installTagTranslations({ female: { glasses: '眼镜' } });
    const onSelect = vi.fn();
    render(<MemoryRouter><Harness exact={false} onSelect={onSelect} /></MemoryRouter>);
    fireEvent.focus(screen.getByRole('combobox'));

    const option = await screen.findByRole('option');
    expect(option).toHaveTextContent('female:glasses');
    expect(option).not.toHaveTextContent('female:glasses$');
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith('female:glasses');
  });

  it('does not steal composition Enter or bubble candidate Enter into the caller', async () => {
    installTagTranslations({ female: { glasses: '眼镜' } });
    const onSelect = vi.fn();
    const outerEnter = vi.fn();
    render(<div onKeyDown={outerEnter}><Harness onSelect={onSelect} /></div>);
    const input = screen.getByRole('combobox');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    fireEvent.focus(input);
    await screen.findByRole('option');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSelect).not.toHaveBeenCalled();
    outerEnter.mockClear();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('female:glasses$');
    expect(outerEnter).not.toHaveBeenCalled();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('dismisses on blur and Escape and only reopens after focus returns', async () => {
    installTagTranslations({ female: { glasses: '眼镜' } });
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    await screen.findByRole('option');
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    fireEvent.blur(input);
    fireEvent.focus(input);
    await screen.findByRole('option');
    fireEvent.blur(input);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('keeps keyboard selection visible inside the candidate menu, including wraparound', async () => {
    installTagTranslations({ female: { glasses: '眼镜', glass: '玻璃', glassblowing: '吹玻璃', glassware: '玻璃器皿' } });
    render(<Harness onSelect={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    const options = await screen.findAllByRole('option');
    const menu = screen.getByRole('listbox');
    Object.defineProperty(menu, 'clientHeight', { configurable: true, value: 64 });
    options.forEach((option, index) => {
      Object.defineProperty(option, 'offsetTop', { configurable: true, value: index * 32 });
      Object.defineProperty(option, 'offsetHeight', { configurable: true, value: 32 });
    });
    for (let index = 1; index < options.length; index++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options.at(-1)).toHaveAttribute('aria-selected', 'true');
    expect(menu.scrollTop).toBe(options.length * 32 - 64);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(menu.scrollTop).toBe(0);
  });

  it('fits the horizontally panned visual viewport and repositions when it changes', async () => {
    installTagTranslations({ female: { glasses: '眼镜' } });
    const viewport = Object.assign(new EventTarget(), { offsetLeft: 200, offsetTop: 0, width: 320, height: 500 });
    const original = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 100, right: 700, top: 100, bottom: 140, width: 600, height: 40, x: 100, y: 100, toJSON: () => ({}),
    });
    try {
      render(<Harness onSelect={vi.fn()} />);
      fireEvent.focus(screen.getByRole('combobox'));
      const panel = await screen.findByRole('listbox');
      expect(panel).toHaveStyle({ left: '208px', width: '304px' });
      viewport.offsetLeft = 300;
      act(() => { viewport.dispatchEvent(new Event('scroll')); });
      expect(panel).toHaveStyle({ left: '308px', width: '304px' });
    } finally {
      rect.mockRestore();
      if (original) Object.defineProperty(window, 'visualViewport', original);
      else Reflect.deleteProperty(window, 'visualViewport');
    }
  });
});
