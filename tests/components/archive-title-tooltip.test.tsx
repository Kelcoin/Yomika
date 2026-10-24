import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ArchiveTitleTooltip } from '../../src/components/ArchiveTitleTooltip';

afterEach(() => vi.useRealTimers());

it('replaces sidebar native titles with themed hints and follows title updates', async () => {
  vi.useFakeTimers();
  const view = render(<><button title="展开侧栏">侧栏</button><ArchiveTitleTooltip /></>);
  const button = screen.getByRole('button');
  expect(button).toHaveAttribute('title', '');
  fireEvent.pointerOver(button, { clientX: 12, clientY: 20 });
  act(() => vi.advanceTimersByTime(650));
  expect(screen.getByRole('tooltip')).toHaveTextContent('展开侧栏');
  fireEvent.pointerOut(button, { relatedTarget: document.body });
  view.rerender(<><button title="折叠侧栏">侧栏</button><ArchiveTitleTooltip /></>);
  await act(async () => {});
  expect(button).toHaveAttribute('title', '');
  fireEvent.pointerOver(button);
  act(() => vi.advanceTimersByTime(650));
  expect(screen.getByRole('tooltip')).toHaveTextContent('折叠侧栏');
  fireEvent.pointerOut(button, { relatedTarget: document.body });
  view.rerender(<><button title="">侧栏</button><ArchiveTitleTooltip /></>);
  await act(async () => {});
  fireEvent.pointerOver(button);
  act(() => vi.advanceTimersByTime(700));
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});

it('themes hints added after a menu opens', async () => {
  vi.useFakeTimers();
  const view = render(<ArchiveTitleTooltip />);
  view.rerender(<><button title="新菜单操作">操作</button><ArchiveTitleTooltip /></>);
  await act(async () => {});
  const button = screen.getByRole('button');
  expect(button).toHaveAttribute('title', '');
  fireEvent.pointerOver(button);
  act(() => vi.advanceTimersByTime(650));
  expect(screen.getByRole('tooltip')).toHaveTextContent('新菜单操作');
});

it('shows the themed title only after pausing and dismisses on scroll or menu', () => {
  vi.useFakeTimers();
  render(<><button data-archive-tooltip="档案标题">封面</button><ArchiveTitleTooltip /></>);
  const card = screen.getByRole('button');
  fireEvent.pointerOver(card, { clientX: 40, clientY: 80 });
  act(() => vi.advanceTimersByTime(600));
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(50));
  expect(screen.getByRole('tooltip')).toHaveTextContent('档案标题');
  expect(screen.getByRole('tooltip')).toHaveClass('archive-title-tooltip');
  fireEvent.scroll(document);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.pointerOver(card);
  act(() => vi.advanceTimersByTime(650));
  fireEvent.contextMenu(card);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});

it('cancels a pending tooltip when leaving the card or unmounting', () => {
  vi.useFakeTimers();
  const view = render(<><button data-archive-tooltip="标题">封面</button><ArchiveTitleTooltip /></>);
  const card = screen.getByRole('button');
  fireEvent.pointerOver(card);
  fireEvent.pointerOut(card, { relatedTarget: document.body });
  act(() => vi.advanceTimersByTime(700));
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.pointerOver(card);
  view.unmount();
  act(() => vi.advanceTimersByTime(700));
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});
