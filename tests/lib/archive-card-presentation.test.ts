import { describe, expect, it } from 'vitest';
import {
  archiveCategoryKey,
  archiveCategoryLabel,
  formatArchiveDate,
  formatArchivePageMeta,
  groupCardTagLines,
  isArchiveFinished,
  isWideCoverRatio,
  pickCardTags,
  pickRandomSample,
} from '../../src/lib/archiveCardPresentation';

describe('archive card presentation', () => {
  it('prefers the archive’s own LANraragi categories over the category tag', () => {
    const archive = { tags: ['category:Manga', 'artist:someone'] };
    // The card called this 分类 while showing the uploader's metadata. What the
    // user organised is the LANraragi category, so that wins when there is one.
    expect(archiveCategoryLabel(archive, ['漫画书架'])).toBe('漫画书架');
    // With no category on the server, the tag is still better than nothing, and
    // it is translated through the one shared map — the card used to print the
    // English casing while the detail pane printed Chinese for the same value.
    expect(archiveCategoryLabel(archive)).toBe('漫画');
    expect(archiveCategoryLabel(archive, [])).toBe('漫画');
    expect(archiveCategoryLabel({ tags: ['category:Asian Porn'] })).toBe('亚洲写真');
    expect(archiveCategoryLabel({ tags: [] })).toBe('');
    // The accent attribute keeps the English name, which is what the stylesheet
    // and E-Hentai's own chips key on.
    expect(archiveCategoryKey(archive)).toBe('Manga');
    expect(archiveCategoryKey({ tags: ['category:gamecg'] })).toBe('Game CG');
    expect(archiveCategoryKey({ tags: ['category:something-new'] })).toBe('');
  });

  it('uses the wide-card threshold', () => {
    expect(isWideCoverRatio(1)).toBe(false);
    expect(isWideCoverRatio(1.01)).toBe(true);
    expect(isWideCoverRatio(null)).toBe(false);
  });

  it('formats added date and reading progress for card corners', () => {
    expect(formatArchiveDate(1776038400)).toBe('2026-04-13');
    expect(formatArchivePageMeta(259, 8)).toBe('8/259 页');
    expect(formatArchivePageMeta(259)).toBe('259 页');
  });

  it('keeps a stable metadata slot when no date or progress exists', () => {
    expect(formatArchiveDate(null)).toBe('');
    expect(formatArchivePageMeta(0)).toBe('');
  });

  it('samples the random rail without repeats and without keeping the source order', () => {
    const items = Array.from({ length: 10 }, (_, index) => index);
    // Fisher-Yates with a maximal draw each step reverses-in the tail items, so
    // the biased `sort(() => Math.random() - 0.5)` shape (leading 0, 1, 2 …) is
    // provably gone.
    const sample = pickRandomSample(items, 4, () => 0.999999);

    expect(sample).toHaveLength(4);
    expect(new Set(sample).size).toBe(4);
    expect(sample[0]).not.toBe(0);
    expect(items).toEqual(Array.from({ length: 10 }, (_, index) => index));
  });

  it('clamps the random rail request to the archive count', () => {
    expect(pickRandomSample([1, 2], 8, () => 0)).toEqual([1, 2]);
    expect(pickRandomSample([], 8)).toEqual([]);
    expect(pickRandomSample([1, 2, 3], -1)).toEqual([]);
  });

  it('ranks content namespaces ahead of bookkeeping ones on a card', () => {
    const tags = ['language:chinese', 'artist:someone', 'female:big breasts', 'parody:original', 'male:glasses', 'character:alice'];

    expect(pickCardTags(tags, 4)).toEqual(['female:big breasts', 'male:glasses', 'character:alice', 'parody:original']);
  });

  it('drops namespaces a card already shows elsewhere', () => {
    const tags = ['date_added:1760742000', 'source:example.com', 'uploader:someone', 'category:manga', 'timestamp:1760742000', 'female:tag'];

    expect(pickCardTags(tags, 6)).toEqual(['female:tag']);
  });

  it('keeps the original order inside one namespace and honours the limit', () => {
    const tags = ['female:b', 'female:a', 'female:c', 'group:z'];

    expect(pickCardTags(tags, 2)).toEqual(['female:b', 'female:a']);
    expect(pickCardTags(tags, 0)).toEqual([]);
    expect(pickCardTags(undefined, 3)).toEqual([]);
  });

  it('keeps unknown namespaces last instead of dropping them', () => {
    expect(pickCardTags(['weird:tag', 'female:tag'], 5)).toEqual(['female:tag', 'weird:tag']);
  });

  it('uses lower-priority descriptive namespaces to fill spare card space', () => {
    const tags = ['language:chinese', 'cosplayer:alice', 'artist:someone', 'other:full color', 'female:glasses'];

    expect(pickCardTags(tags, 5)).toEqual([
      'female:glasses',
      'other:full color',
      'artist:someone',
      'cosplayer:alice',
      'language:chinese',
    ]);
  });

  it('ranks watched tags before ordinary tags for waterfall placement', () => {
    // Watched tags lead the input; shortest-row placement spreads them across rows.
    const tags = ['language:chinese', 'artist:someone', 'female:big breasts', 'group:circle', 'artist:other'];
    expect(pickCardTags(tags, 5, new Set(['artist:someone', 'group:z']))).toEqual([
      'artist:someone',
      'female:big breasts',
      'artist:other',
      'group:circle',
      'language:chinese',
    ]);
    // 无优先集合时行为与原来一致。
    expect(pickCardTags(tags, 3)).toEqual(['female:big breasts', 'artist:someone', 'artist:other']);
  });

  it('reserves card slots for watched tags so they always survive the slice', () => {
    // 低优先命名空间的 watched 标签优先保留席位：低优先的未 watched 让位。
    // Watched tags occupy the leftmost waterfall slots.
    const tags = ['female:a', 'female:b', 'female:c', 'language:watched-me'];
    expect(pickCardTags(tags, 3, new Set(['language:watched-me']))).toEqual([
      'language:watched-me',
      'female:a',
      'female:b',
    ]);
    // 卡片不显示的命名空间（category）即便被 watched 也不占席位。
    expect(pickCardTags(['category:manga', 'female:a', 'female:b'], 2, new Set(['category:manga']))).toEqual([
      'female:a',
      'female:b',
    ]);
  });

  it('splits the ranked line into contiguous namespace groups for the wide card', () => {
    expect(groupCardTagLines(['female:a', 'female:b', 'male:c', 'artist:d'])).toEqual([
      { namespace: 'female', label: '女性', tags: ['female:a', 'female:b'] },
      { namespace: 'male', label: '男性', tags: ['male:c'] },
      { namespace: 'artist', label: '作者', tags: ['artist:d'] },
    ]);
    // 无命名空间的标签归入通用组。
    expect(groupCardTagLines(['plain'])).toEqual([
      { namespace: 'general', label: '通用', tags: ['plain'] },
    ]);
    expect(groupCardTagLines([])).toEqual([]);
  });

  it('counts a record finished past 95% of its pages', () => {
    expect(isArchiveFinished(259, 259)).toBe(true);
    expect(isArchiveFinished(259, 247)).toBe(true); // 95.4% —— 双页尾页可能丢一次保存
    expect(isArchiveFinished(259, 246)).toBe(false);
    expect(isArchiveFinished(259, 0)).toBe(false);
    expect(isArchiveFinished(0, 10)).toBe(false);
    expect(isArchiveFinished(20, null)).toBe(false);
  });
});
