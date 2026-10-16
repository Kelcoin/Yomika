import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Route preloading also imports the shared hook. Each case needs a fresh cache.
vi.hoisted(() => { vi.resetModules(); });
import { useEhMyTags } from '../../src/components/useEhMyTags';
import { setEhMyTagsPriorityEnabled } from '../../src/lib/ehMyTags';
import { NativeEhRepository } from '../../src/repositories/nativeEhRepository';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

const repository = new NativeEhRepository();
const account = (id: string) => ({ id, label: id, host: 'e-hentai.org', cookieRef: id, isActive: true, status: 'verified', createdAt: 'now', updatedAt: 'now' });
const tags = (name: string) => [{ tagId: 1, namespace: 'artist', tagKey: name, watched: true, hidden: false, weight: 1, color: '#112233' }];
function Consumer({ label = 'tags' }: { label?: string }) {
  const presentation = useEhMyTags();
  return <output aria-label={label}>{presentation.priority.join(',')}</output>;
}

beforeEach(() => { setEhMyTagsPriorityEnabled(true); });
afterEach(() => { setEhMyTagsPriorityEnabled(false); resetInvokeAdapterForTests(); });

describe('my tags account lifetime', () => {
  it('clears logged-out tags and loads the newly imported account for mounted consumers', async () => {
    let current: string | undefined = 'a';
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_eh_accounts') return { ok: true, value: current ? [account(current)] : [] };
      if (command === 'list_eh_my_tags') return { ok: true, value: tags(current!) };
      if (command === 'remove_eh_account') { current = undefined; return { ok: true, value: null }; }
      if (command === 'save_eh_account') { current = 'b'; return { ok: true, value: account('b') }; }
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<><Consumer /><Consumer label="second" /></>);
    await waitFor(() => expect(screen.getByLabelText('tags')).toHaveTextContent('artist:a'));
    await act(async () => { await repository.removeAccount('a'); });
    await waitFor(() => expect(screen.getByLabelText('tags')).toHaveTextContent(/^$/));
    await act(async () => { await repository.saveAccount({ id: 'b', label: 'b', host: 'e-hentai.org', cookie: 'cookie' }); });
    await waitFor(() => expect(screen.getByLabelText('tags')).toHaveTextContent('artist:b'));
    expect(screen.getByLabelText('second')).toHaveTextContent('artist:b');
    expect(adapter.mock.calls.filter(([command]) => command === 'list_eh_my_tags')).toHaveLength(2);
  });

  it('rejects a tag load from an earlier login even when the account ID stays the same', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    let reads = 0;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_eh_accounts') return { ok: true, value: [account('same')] };
      if (command === 'list_eh_my_tags') return ++reads === 1 ? pending : { ok: true, value: tags('new') };
      if (command === 'save_eh_account') return { ok: true, value: account('same') };
      throw new Error(command);
    });
    await repository.saveAccount({ id: 'same', label: 'same', host: 'e-hentai.org', cookie: 'initial' });
    render(<Consumer />);
    await waitFor(() => expect(reads).toBe(1));
    await act(async () => { await repository.saveAccount({ id: 'same', label: 'same', host: 'e-hentai.org', cookie: 'new' }); });
    await waitFor(() => expect(screen.getByLabelText('tags')).toHaveTextContent('artist:new'));
    await act(async () => finish({ ok: true, value: tags('old') }));
    expect(screen.getByLabelText('tags')).toHaveTextContent('artist:new');
  });
});
