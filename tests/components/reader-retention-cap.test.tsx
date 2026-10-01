import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('../../src/components/LibraryRouteWorkspace', () => ({ LibraryRouteWorkspace: () => <input aria-label="retained library" /> }));
vi.mock('../../src/components/ArchiveDetailRoute', () => ({ ArchiveDetailRoute: () => null }));
vi.mock('../../src/components/SettingsWorkspace', () => ({ SettingsWorkspace: () => null }));
vi.mock('../../src/components/ReaderRoute', () => ({
  ReaderRoute: () => {
    const [params] = useSearchParams();
    return <input aria-label="retained reader" data-server={params.get('server') ?? ''} readOnly />;
  },
}));
vi.mock('../../src/components/StatusBar', () => ({ StatusBar: () => null }));

import { App } from '../../src/app/App';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

function Navigation() {
  const go = useNavigate();
  return <>{['server-a', 'server-b', 'server-c'].map((server) => <button key={server} onClick={() => go(`/reader/archive?server=${server}`)}>{server}</button>)}</>;
}

/** Every reader instance still mounted, hidden or not: `ByLabelText` does not
 * drop the ones the shell keeps with `hidden`. */
function mountedReaders() {
  return screen.queryAllByLabelText('retained reader').map((node) => node.getAttribute('data-server'));
}

afterEach(resetInvokeAdapterForTests);

it('keeps only the active reader and the most recently read one mounted', async () => {
  setInvokeAdapterForTests(async (command) => ({ ok: true, value: command === 'load_preferences' ? DEFAULT_PREFERENCES : [] }));
  render(<MemoryRouter initialEntries={['/reader/archive?server=server-a']}><Navigation /><App /></MemoryRouter>);

  expect(await screen.findByLabelText('retained reader')).toHaveAttribute('data-server', 'server-a');

  fireEvent.click(screen.getByRole('button', { name: 'server-b' }));
  fireEvent.click(screen.getByRole('button', { name: 'server-c' }));

  // The least recently read archive is unmounted, not merely hidden: its DOM,
  // its image handles and its derived renditions go away with it.
  expect(mountedReaders()).toEqual(['server-b', 'server-c']);
});

it('re-reading an archive makes it the most recent, so the one after it is evicted', async () => {
  setInvokeAdapterForTests(async (command) => ({ ok: true, value: command === 'load_preferences' ? DEFAULT_PREFERENCES : [] }));
  render(<MemoryRouter initialEntries={['/reader/archive?server=server-a']}><Navigation /><App /></MemoryRouter>);

  expect(await screen.findByLabelText('retained reader')).toHaveAttribute('data-server', 'server-a');

  fireEvent.click(screen.getByRole('button', { name: 'server-b' }));
  fireEvent.click(screen.getByRole('button', { name: 'server-a' }));
  fireEvent.click(screen.getByRole('button', { name: 'server-c' }));

  expect(mountedReaders()).toEqual(['server-a', 'server-c']);
});
