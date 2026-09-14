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

  it('picks ink by the preset colour’s luminance', () => {
    expect(readableInkOnHex('#ffffff')).toBe('#1c1c1e');
    expect(readableInkOnHex('#000000')).toBe('#ffffff');
    expect(readableInkOnHex('#ff8800')).toBe('#1c1c1e');
    expect(readableInkOnHex('#112233')).toBe('#ffffff');
    expect(readableInkOnHex('nope')).toBe('');
  });
});
