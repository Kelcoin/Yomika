import { describe, expect, it } from 'vitest';

import { appendUploadItems, parseUploadUrls, partitionUploadPaths } from '../../src/domain/upload';

describe('upload queue rules', () => {
  it('accepts only archive extensions and reports the rest', () => {
    const { accepted, rejected } = partitionUploadPaths([
      'C:/a/one.cbz',
      'C:/a/two.ZIP',
      'C:/a/notes.txt',
      'C:/a/folder',
      'C:/a/one.cbz',
    ]);
    expect(accepted).toEqual(['C:/a/one.cbz', 'C:/a/two.ZIP']);
    expect(rejected).toEqual(['C:/a/notes.txt', 'C:/a/folder']);
  });

  it('keeps unparseable and non-http lines out of the valid set', () => {
    const { valid, invalid } = parseUploadUrls([
      'https://example.com/g/1/abc',
      '  http://example.com/g/2/def  ',
      'https://example.com/g/1/abc',
      'ftp://example.com/file.zip',
      'not a url',
      '',
    ].join('\n'));
    expect(valid).toEqual(['https://example.com/g/1/abc', 'http://example.com/g/2/def']);
    expect(invalid).toEqual(['ftp://example.com/file.zip', 'not a url']);
  });

  it('does not stack a second copy of something already queued', () => {
    const first = appendUploadItems([], 'file', ['C:/a/one.cbz']);
    const again = appendUploadItems(first, 'file', ['C:/a/one.cbz', 'C:/a/two.cbz']);
    expect(again.map((item) => item.label)).toEqual(['one.cbz', 'two.cbz']);
    // A URL and a file are separate namespaces, so identical text in both kinds
    // is two items rather than a collision.
    const mixed = appendUploadItems(again, 'url', ['https://example.com/one.cbz']);
    expect(mixed).toHaveLength(3);
    expect(mixed[2]?.kind).toBe('url');
  });

  it('names a file item by its file name and a url item by the url', () => {
    const items = appendUploadItems(appendUploadItems([], 'file', ['D:/in/deep/名前.cbz']), 'url', ['https://example.com/g/9/z']);
    expect(items[0]?.label).toBe('名前.cbz');
    expect(items[0]?.source).toBe('D:/in/deep/名前.cbz');
    expect(items[1]?.label).toBe('https://example.com/g/9/z');
  });
});
