import baseline from '../fixtures/readoshi-baseline.json';

describe('Readoshi migration baseline', () => {
  it('pins the approved migration source', () => {
    expect(baseline.version).toBe('1.6.3');
    expect(baseline.commit).toBe('b99539f');
    expect(baseline.features).toEqual(expect.arrayContaining([
      'archives',
      'reader',
      'history',
      'watchlist',
      'metadata',
      'uploads',
      'deduplication',
      'ehentai',
      'superResolution',
    ]));
  });
});
