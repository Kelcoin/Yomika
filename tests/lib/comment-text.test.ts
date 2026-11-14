import { describe, expect, it } from 'vitest';
import { readableCommentText } from '../../src/lib/commentText';

describe('comment combining marks', () => {
  it('limits stacked Thai and Zalgo marks without removing the base text', () => {
    expect(readableCommentText(`Hello ก${'ู'.repeat(100)} 中文`)).toBe('Hello กููู 中文');
    expect(readableCommentText(`x${'\u030d'.repeat(100)} end`)).toBe(`x${'\u030d'.repeat(3)} end`);
  });
  it('preserves ordinary languages, links, accents and emoji', () => {
    const text = '中文 กิ่ café e\u0301 👩🏽‍💻 ❤️ https://exhentai.org/g/123/abc/';
    expect(readableCommentText(text)).toBe(text.normalize('NFC'));
  });
});
