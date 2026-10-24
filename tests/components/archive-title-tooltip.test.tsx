import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ArchiveTitleTooltip } from '../../src/components/ArchiveTitleTooltip';

afterEach(() => vi.useRealTimers());

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
