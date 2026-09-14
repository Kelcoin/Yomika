import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('../../src/components/LibraryRouteWorkspace', () => ({ LibraryRouteWorkspace: () => <input aria-label="retained library" /> }));
vi.mock('../../src/components/ArchiveDetailRoute', () => ({ ArchiveDetailRoute: ({ archiveId }: { archiveId: string }) => {
  const [params] = useSearchParams();
  return <h1>{archiveId}:{params.get('server')}</h1>;
} }));
vi.mock('../../src/components/SettingsWorkspace', () => ({ SettingsWorkspace: () => <input aria-label="retained settings" /> }));
vi.mock('../../src/components/ReaderRoute', () => ({ ReaderRoute: () => <input aria-label="retained reader" /> }));
vi.mock('../../src/components/StatusBar', () => ({ StatusBar: () => null }));

import { App } from '../../src/app/App';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

function Navigation() {
  const navigate = useNavigate();
  return <>{['/library', '/library/archive-a?server=server-a', '/settings', '/reader/archive-a?server=server-a'].map((path) => <button key={path} onClick={() => navigate(path)}>{path}</button>)}</>;
}
afterEach(resetInvokeAdapterForTests);

it('retains split selection, route scope, page DOM and input state through settings and reader', async () => {
  setInvokeAdapterForTests(async (command) => ({ ok: true, value: command === 'load_preferences' ? DEFAULT_PREFERENCES : [] }));
  render(<MemoryRouter initialEntries={['/library']}><Navigation /><App /></MemoryRouter>);
  const library = screen.getByRole('textbox', { name: 'retained library' });
  fireEvent.change(library, { target: { value: 'my search' } });
  fireEvent.click(screen.getByRole('button', { name: '/library/archive-a?server=server-a' }));
  const detail = screen.getByRole('heading', { name: 'archive-a:server-a' });
  expect(screen.getByRole('textbox', { name: 'retained library' })).toBe(library);
  fireEvent.click(screen.getByRole('button', { name: '/settings' }));
  const settings = await screen.findByRole('textbox', { name: 'retained settings' });
  fireEvent.change(settings, { target: { value: 'draft' } });
  expect(detail).not.toBeVisible();
  expect(detail).toHaveTextContent('archive-a:server-a');
  fireEvent.click(screen.getByRole('button', { name: '/library' }));
  expect(await screen.findByRole('heading', { name: 'archive-a:server-a' })).toBe(detail);
  expect(library).toHaveValue('my search');
  fireEvent.click(screen.getByRole('button', { name: '/reader/archive-a?server=server-a' }));
  const reader = await screen.findByRole('textbox', { name: 'retained reader' });
  fireEvent.change(reader, { target: { value: 'page 12' } });
  expect(library).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '/settings' }));
  expect(await screen.findByRole('textbox', { name: 'retained settings' })).toBe(settings);
  expect(settings).toHaveValue('draft');
  fireEvent.click(screen.getByRole('button', { name: '/reader/archive-a?server=server-a' }));
  expect(await screen.findByRole('textbox', { name: 'retained reader' })).toBe(reader);
  expect(reader).toHaveValue('page 12');
});
