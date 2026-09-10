import { categorizeSearchableTags, categorizeTags, installTagTranslations, normalizeTranslationDb, parseArchiveTagString, searchTags, translateTag } from '../../src/lib/tags';
import { formatArchiveDate } from '../../src/lib/archiveCardPresentation';

describe('tag translations', () => {
  it('replaces raw EH tags with the installed Chinese translation', () => {
    installTagTranslations({ female: { 'big breasts': '巨乳', 'dark skin': '黑皮' } });
    expect(categorizeTags(['female:big breasts', 'female:dark skin'])).toEqual([
      { namespace: 'female', label: '女性', values: ['巨乳', '黑皮'] },
    ]);
  });

  it('keeps the raw exact query beside a translated tag label', () => {
    installTagTranslations({ female: { 'big breasts': '巨乳' } });

    expect(categorizeSearchableTags(['female:big breasts', 'plain tag'])).toEqual([
      { namespace: 'female', label: '女性', values: [{ label: '巨乳', query: 'female:big breasts$' }] },
      { namespace: 'general', label: '通用', values: [{ label: 'plain tag', query: 'plain tag$' }] },
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

  it('normalizes the upstream database without one DOM parse per entry', () => {
    // The real db.html.json holds 50k+ entries; a DOMParser document each froze
    // the main thread for seconds.
    const parseFromString = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const entries = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`tag-${index}`, { name: `<p>标签&amp;${index}</p>` }]),
    );

    const normalized = normalizeTranslationDb({ data: [{ namespace: 'female', data: entries }] });

    expect(normalized.female?.['tag-7']).toBe('标签&7');
    expect(parseFromString).not.toHaveBeenCalled();
    parseFromString.mockRestore();
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

  it('renders date namespaces on the same calendar basis as card metadata', () => {
    // Both renderers must agree; the tag path used to format in UTC while the
    // card corner formatted locally, so the same archive showed two days.
    expect(translateTag('date_added', '1760742000')).toBe(formatArchiveDate(1_760_742_000));
    expect(translateTag('timestamp', '1760742000000')).toBe(formatArchiveDate(1_760_742_000));
    expect(translateTag('date_added', 'not-a-date')).toBe('not-a-date');
  });

  it('finds a Chinese label by full pinyin and by initials', () => {
    // A latin keyboard cannot reach 眼镜 otherwise: this is what "typing
    // yanjing suggests female:glasses$" means.
    installTagTranslations({ female: { glasses: '眼镜', 'big breasts': '巨乳' }, artist: { sample: '示例作者' } });

    expect(searchTags('yanjing').map((item) => `${item.namespace}:${item.key}`)).toContain('female:glasses');
    expect(searchTags('yanj').map((item) => `${item.namespace}:${item.key}`)).toContain('female:glasses');
    expect(searchTags('yj').map((item) => `${item.namespace}:${item.key}`)).toContain('female:glasses');
    expect(searchTags('juru').map((item) => `${item.namespace}:${item.key}`)).toContain('female:big breasts');
    expect(searchTags('zzzz')).toEqual([]);
  });
});
