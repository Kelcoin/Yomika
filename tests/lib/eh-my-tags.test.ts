import { describe, expect, it } from 'vitest';

import {
  buildMyTagPresentation,
  normalizeMyTagKey,
  prioritizeByMyTags,
  readableInkOnHex,
} from '../../src/lib/ehMyTags';
import type { EhMyTag } from '../../src/domain/eh';

function tag(overrides: Partial<EhMyTag> & { tagId: number; namespace: string; tagKey: string }): EhMyTag {
  return { watched: true, hidden: false, weight: 0, color: null, ...overrides };
}

describe('E-Hentai my tags presentation', () => {
  it('folds case and underscores so both sides of the match agree', () => {
    expect(normalizeMyTagKey('Artist:Big_Breasts')).toBe('artist:big breasts');
    expect(normalizeMyTagKey('female:big breasts')).toBe('female:big breasts');
    expect(normalizeMyTagKey('  plain ')).toBe('plain');
  });

  it('collects only watched tags, in weight order, with their preset colours', () => {
    const presentation = buildMyTagPresentation([
      tag({ tagId: 3, namespace: 'female', tagKey: 'glasses', weight: 0, color: '#ff8800' }),
      tag({ tagId: 1, namespace: 'artist', tagKey: 'some_one', weight: 5, color: '#00aabb' }),
      tag({ tagId: 2, namespace: 'general', tagKey: 'plain', weight: 1, color: null }),
      tag({ tagId: 4, namespace: 'male', tagKey: 'not watched', watched: false }),
      tag({ tagId: 5, namespace: 'male', tagKey: 'hidden only', watched: false, hidden: true }),
    ]);

    expect(presentation.priority).toEqual([
      'artist:some one',
      'plain',
      'female:glasses',
    ]);
    expect(presentation.colors.get('artist:some one')).toBe('#00aabb');
    expect(presentation.colors.get('male:not watched')).toBeUndefined();
  });

  it('moves watched tags left in place — not to the first row', () => {
    const presentation = buildMyTagPresentation([
      tag({ tagId: 1, namespace: 'female', tagKey: 'glasses', color: '#ff8800' }),
      tag({ tagId: 2, namespace: 'artist', tagKey: 'b', weight: 2 }),
    ]);
    // 只做稳定分区：watched 靠左且保持原有相对次序，不跨命名空间抢位。
    expect(prioritizeByMyTags(['artist:a', 'female:glasses', 'parody:original', 'artist:b'], presentation)).toEqual([
      'female:glasses',
      'artist:b',
      'artist:a',
      'parody:original',
    ]);
    // 无 watched 标签时原样返回。
    expect(prioritizeByMyTags(['b', 'a'], { priority: [], colors: new Map() })).toEqual(['b', 'a']);
  });

  it('picks the highest-contrast ink for the preset colour', () => {
    expect(readableInkOnHex('#ffffff')).toBe('#000000');
    expect(readableInkOnHex('#000000')).toBe('#ffffff');
    expect(readableInkOnHex('#ff8800')).toBe('#000000');
    expect(readableInkOnHex('#112233')).toBe('#ffffff');
    expect(readableInkOnHex('nope')).toBe('');
  });

  it('keeps every mid-tone background at or above WCAG small-text contrast', () => {
    const contrast = (bg: string, fg: string) => {
      const parse = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
      const linear = (channel: number) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      const [r1, g1, b1] = parse(bg).map(linear) as [number, number, number];
      const [r2, g2, b2] = parse(fg).map(linear) as [number, number, number];
      const l1 = 0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1;
      const l2 = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    // 旧阈值在中明度带（L 0.25–0.40）会配出 2.8–4.5:1 的白墨——那段全部失守。
    for (let l100 = 20; l100 <= 90; l100 += 5) {
      const scaled = l100 / 100;
      const channel = Math.round(255 * (scaled > 0.04045 ? (scaled * 1.055 - 0.055) ** (1 / 2.4) : scaled * 12.92));
      const bg = `#${channel.toString(16).padStart(2, '0').repeat(3)}`;
      const ink = readableInkOnHex(bg);
      expect(contrast(bg, ink), `bg ${bg} ink ${ink}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
