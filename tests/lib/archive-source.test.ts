import { archiveSourceUrl } from '../../src/lib/archiveSource';

it('finds an HTTP gallery source without treating another namespace as a URL', () => {
  expect(archiveSourceUrl(['artist:https://example.com', 'source: https://e-hentai.org/g/123/token/'])).toBe('https://e-hentai.org/g/123/token/');
});
it.each(['javascript:alert(1)', 'file:///C:/test', 'https://', 'https://user:password@example.com', 'https://exa mple.com', '//example.com'])('rejects invalid source %s', (source) => {
  expect(archiveSourceUrl([`source:${source}`])).toBeUndefined();
});
it('skips an invalid source and accepts the next valid one', () => {
  expect(archiveSourceUrl(['source:not a link', 'source:https://example.com/gallery/1'])).toBe('https://example.com/gallery/1');
});
