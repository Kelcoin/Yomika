import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('../../src/components/LibraryRouteWorkspace', () => ({
  LibraryRouteWorkspace: () => <input aria-label="library search" defaultValue="" />,
}));
vi.mock('../../src/components/ArchiveDetailRoute', () => ({
  ArchiveDetailRoute: ({ archiveId }: { archiveId: string }) => <p>{archiveId}</p>,
}));
import { LibraryShell } from '../../src/components/LibraryShell';

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
