import { categorizeTags, installTagTranslations, normalizeTranslationDb, parseArchiveTagString, searchTags } from '../../src/lib/tags';

describe('tag translations', () => {
  it('replaces raw EH tags with the installed Chinese translation', () => {
    installTagTranslations({ female: { 'big breasts': '巨乳', 'dark skin': '黑皮' } });
    expect(categorizeTags(['female:big breasts', 'female:dark skin'])).toEqual([
      { namespace: 'female', label: '女性', values: ['巨乳', '黑皮'] },
    ]);
  });

  it('normalizes real EhTagTranslation sections and ignores rows metadata', () => {
    const normalized = normalizeTranslationDb({
      data: [
        { namespace: 'rows', data: { female: { name: '<p>女性</p>', intro: '<p>女性标签</p>' } } },
        { namespace: 'female', data: { 'big breasts': { name: '<p>巨乳</p>' }, 'dark skin': { name: '<p>黑皮</p>' } } },
      ],
    });
    expect(normalized.female?.['big breasts']).toBe('巨乳');
    expect(normalized.female?.['dark skin']).toBe('黑皮');
    expect(normalized.female?.name).toBeUndefined();
  });

  it('decodes HTML entities in upstream translation names', () => {
    const normalized = normalizeTranslationDb({
      data: [{ namespace: 'parody', data: { sample: { name: '<p>骑士&amp;魔法</p>' } } }],
    });
    expect(normalized.parody?.sample).toBe('骑士&魔法');
  });

  it('splits LANraragi metadata tags only at commas', () => {
    expect(parseArchiveTagString('female:big breasts, artist:sample artist')).toEqual([
      'female:big breasts',
      'artist:sample artist',
    ]);
  });

  it('indexes translated tags for namespace-aware suggestions', () => {
    installTagTranslations({ female: { 'big breasts': '巨乳' }, artist: { sample: '示例作者' } });
    expect(searchTags('female:big').map((item) => item.namespace + ':' + item.key)).toContain('female:big breasts');
    expect(searchTags('示例').map((item) => item.namespace)).toContain('artist');
  });
});
