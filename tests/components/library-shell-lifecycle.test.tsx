import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('../../src/components/LibraryRouteWorkspace', () => ({
  LibraryRouteWorkspace: () => <input aria-label="library search" defaultValue="" />,
}));
vi.mock('../../src/components/ArchiveDetailRoute', () => ({
  ArchiveDetailRoute: ({ archiveId }: { archiveId: string }) => <p>{archiveId}</p>,
}));
import { LibraryShell } from '../../src/components/LibraryShell';
import { ShelfShell } from '../../src/components/ShelfShell';

it.each(['/library', '/history', '/watchlist', '/to-read'])('retains %s list state through detail changes and back/forward', (base) => {
  function Navigation() {
    const navigate = useNavigate();
    return <>
      <button onClick={() => navigate(`${base}/archive-a?server=one`)}>open A</button>
      <button onClick={() => navigate(`${base}/archive-b?server=two`)}>open B</button>
      <button onClick={() => navigate(-1)}>back</button>
      <button onClick={() => navigate(1)}>forward</button>
    </>;
  }
  const view = render(<MemoryRouter initialEntries={[base]}><Navigation /><Routes>
    <Route path={`${base}/:archiveId?`} element={base === '/library' ? <LibraryShell />
      : <ShelfShell name={base.slice(1)} detailBasePath={base}><input aria-label="shelf search" /></ShelfShell>} />
  </Routes></MemoryRouter>);
  try {
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'keep this filter' } });
    fireEvent.click(screen.getByText('open A'));
    expect(screen.getByText('archive-a')).toBeInTheDocument();
    fireEvent.click(screen.getByText('open B'));
    expect(screen.getByText('archive-b')).toBeInTheDocument();
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByText('archive-a')).toBeInTheDocument();
    fireEvent.click(screen.getByText('back'));
    expect(screen.queryByText('archive-a')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('keep this filter');
    fireEvent.click(screen.getByText('forward'));
    expect(screen.getByText('archive-a')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBe(input);
  } finally { view.unmount(); }
});

it('keeps compact list DOM and scroll position across actual detail navigation', () => {
  const originalMedia = window.matchMedia;
  window.matchMedia = (media) => ({ matches: true, media,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true), onchange: null });
  function Navigation() {
    const navigate = useNavigate();
    return <><button onClick={() => navigate('/library/archive-a')}>open detail</button><button onClick={() => navigate(-1)}>back</button></>;
  }
  const view = render(<MemoryRouter initialEntries={['/library']}><div className="workspace"><Navigation /><Routes>
    <Route path="/library/:archiveId?" element={<LibraryShell />} />
  </Routes></div></MemoryRouter>);
  try {
    const input = screen.getByRole('textbox', { name: 'library search' });
    const workspace = view.container.querySelector('.workspace') as HTMLElement;
    fireEvent.change(input, { target: { value: 'retained search' } });
    workspace.scrollTop = 650;
    fireEvent.scroll(workspace);
    fireEvent.click(screen.getByText('open detail'));
    workspace.scrollTop = 120;
    fireEvent.scroll(workspace);
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('retained search');
    expect(workspace.scrollTop).toBe(650);
  } finally { view.unmount(); window.matchMedia = originalMedia; }
});

it('keeps the same library DOM and state when opening and closing a split detail', () => {
  const view = render(<MemoryRouter><LibraryShell /></MemoryRouter>);
  const input = screen.getByRole('textbox', { name: 'library search' });
  fireEvent.change(input, { target: { value: 'artist:sample' } });
  view.rerender(<MemoryRouter><LibraryShell archiveId="archive-a" /></MemoryRouter>);
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input).toHaveValue('artist:sample');
  view.rerender(<MemoryRouter><LibraryShell /></MemoryRouter>);
  expect(screen.getByRole('textbox')).toBe(input);
});
