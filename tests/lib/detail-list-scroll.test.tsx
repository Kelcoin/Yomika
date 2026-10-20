import { useRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useDetailListScroll } from '../../src/lib/useDetailListScroll';

it('ignores hidden compact list clamping while detail is open', () => {
  function Page({ detail }: { detail: boolean }) {
    const list = useRef<HTMLElement>(null);
    useDetailListScroll(detail, list);
    return <div className="workspace"><section ref={list} /></div>;
  }
  const view = render(<Page detail={false} />);
  try {
    const list = view.container.querySelector('section')!;
    vi.spyOn(list, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
    list.scrollTop = 650;
    fireEvent.scroll(list);
    view.rerender(<Page detail />);
    list.scrollTop = 0;
    fireEvent.scroll(list);
    view.rerender(<Page detail={false} />);
    expect(list.scrollTop).toBe(650);
  } finally { view.unmount(); }
});

it('keeps new list scrolling while a split detail is open', () => {
  function Page({ detail }: { detail: boolean }) {
    const list = useRef<HTMLElement>(null);
    useDetailListScroll(detail, list);
    return <div className="workspace"><section ref={list}><div data-testid="list-scroll" /></section></div>;
  }
  const view = render(<Page detail={false} />);
  try {
    const section = view.container.querySelector('section')!;
    vi.spyOn(section, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    const scroller = view.getByTestId('list-scroll');
    scroller.scrollTop = 650;
    fireEvent.scroll(scroller);
    view.rerender(<Page detail />);
    scroller.scrollTop = 800;
    fireEvent.scroll(scroller);
    view.rerender(<Page detail={false} />);
    expect(scroller.scrollTop).toBe(800);
  } finally { view.unmount(); }
});

it('restores the retained list position instead of the detail scroll or its clamped zero', () => {
  vi.useFakeTimers();
  function Page({ detail }: { detail: boolean }) {
    const list = useRef<HTMLElement>(null);
    useDetailListScroll(detail, list);
    return <div className="workspace"><section ref={list}><input defaultValue="retained" /></section>{detail && <p>detail</p>}</div>;
  }
  const view = render(<Page detail={false} />);
  try {
    const workspace = view.container.firstElementChild as HTMLElement;
    const input = view.container.querySelector('input');
    workspace.scrollTop = 1800;
    fireEvent.scroll(workspace);
    view.rerender(<Page detail />);
    workspace.scrollTop = 0;
    fireEvent.scroll(workspace);
    workspace.scrollTop = 420;
    fireEvent.scroll(workspace);
    view.rerender(<Page detail={false} />);
    act(() => vi.advanceTimersByTime(32));
    expect(workspace.scrollTop).toBe(1800);
    expect(view.container.querySelector('input')).toBe(input);
  } finally { view.unmount(); vi.useRealTimers(); }
});
