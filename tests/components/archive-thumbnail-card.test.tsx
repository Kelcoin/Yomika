import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('../../src/lib/nativeImageCache', () => ({
  getNativeImageCache: () => ({
    load: vi.fn().mockRejectedValue(new Error('cover unavailable in component test')),
    release: vi.fn(),
  }),
}));

import { ArchiveThumbnailCard } from '../../src/components/ArchiveThumbnailCard';

describe('archive thumbnail card', () => {
  it('keeps the page count clear of decorative navigation icons', () => {
    const { container } = render(
      <MemoryRouter>
        <ArchiveThumbnailCard
          archive={{
            serverId: 'server-a',
            archiveId: 'archive-a',
            title: 'Archive A',
            pageCount: 169,
            updatedAt: '2026-09-02T00:00:00Z',
            addedAt: 1_760_742_000,
            tags: ['language:chinese'],
          }}
          scopeId="scope-a"
          serverId="server-a"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('169 页')).toBeInTheDocument();
    expect(container.querySelector('.archive-thumb-card-body > svg')).toBeNull();
  });

  it('links to the detail page on the server the archive came from', () => {
    // Two configured servers: a card must carry its own source server, or the
    // detail page (and from it the reader) opens the archive against the
    // first one — the wrong content when archive ids collide.
    render(
      <MemoryRouter>
        <ArchiveThumbnailCard
          archive={{
            serverId: 'server-b',
            archiveId: 'archive-b',
            title: 'Archive B',
            pageCount: 12,
            updatedAt: '2026-09-02T00:00:00Z',
            addedAt: 1_760_742_000,
            tags: [],
          }}
          scopeId="scope-b"
          serverId="server-b"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /Archive B/ })).toHaveAttribute(
      'href',
      '/library/archive-b?server=server-b',
    );
  });
});
