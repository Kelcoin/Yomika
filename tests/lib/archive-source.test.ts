import { archiveSourceUrl } from '../../src/lib/archiveSource';

it('finds an HTTP gallery source without treating another namespace as a URL', () => {
  expect(archiveSourceUrl(['artist:https://example.com', 'source: https://e-hentai.org/g/123/token/'])).toBe('https://e-hentai.org/g/123/token/');
});
it.each(['javascript:alert(1)', 'file:///C:/test', 'https://', 'https://user:password@example.com', 'https://exa mple.com'])('rejects invalid source %s', (source) => {
  expect(archiveSourceUrl([`source:${source}`])).toBeUndefined();
});
it('skips an invalid source and accepts the next valid one', () => {
  expect(archiveSourceUrl(['source:not a link', 'source:https://example.com/gallery/1'])).toBe('https://example.com/gallery/1');
});

it.each([
  ['e-hentai.org/g/123/token/', 'https://e-hentai.org/g/123/token/'],
  ['exhentai.org/g/123/token', 'https://exhentai.org/g/123/token'],
  ['//e-hentai.org/g/123/token/', 'https://e-hentai.org/g/123/token/'],
  ['www.example.com/gallery/123?ref=test#page', 'https://www.example.com/gallery/123?ref=test#page'],
  ['example.com:8443/gallery/123', 'https://example.com:8443/gallery/123'],
])('normalizes a protocol-free source %s', (source, expected) => {
  expect(archiveSourceUrl(['source: ' + source])).toBe(expected);
});

it.each(['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/gallery', 'ftp://example.com/gallery', '/g/123/token', '../example.com/gallery', 'example.com@gallery.test/path', 'example.com\\gallery', 'example.com/\u0000gallery'])('rejects unsafe or ambiguous protocol-free source %s', (source) => {
  expect(archiveSourceUrl(['source:' + source])).toBeUndefined();
});
