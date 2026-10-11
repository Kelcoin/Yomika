import { installTagCounts, setTagCountOrderEnabled } from '../../src/lib/tagCountService';
import { searchTags, installTagTranslations } from '../../src/lib/tags';

/** 第 23 项：补全建议的排序规则（同相关度内按全站使用频次从高到低）。
 *
 * 两条候选的 key 都以 `big` 开头，相关度因此完全相同，排序只由频次那一档决定——
 * 这正是「按使用频次排序」这个开关该起作用的地方。频次方向写反（升序）时，第一条
 * 断言里的 `big ass` 会跑到最前面，而它恰好是字母序也要排在前面的那条，所以第二条
 * 断言（开关关掉）必须与第一条**相反**，两条一起才钉得住方向。 */
describe('tag suggestion ordering', () => {
  beforeEach(() => {
    localStorage.clear();
    installTagCounts([]);
    setTagCountOrderEnabled(false);
    installTagTranslations({ female: { 'big breasts': 'Big Breasts', 'big ass': 'Big Ass' } });
  });

  afterEach(() => {
    setTagCountOrderEnabled(false);
    installTagCounts([]);
  });

  it('ranks by site-wide frequency inside one relevance tier when the rule is on', () => {
    installTagCounts([['female:big breasts', 900], ['female:big ass', 120]]);
    setTagCountOrderEnabled(true);

    expect(searchTags('big').map((item) => item.key)).toEqual(['big breasts', 'big ass']);
  });

  it('falls back to the label order when the rule is off', () => {
    installTagCounts([['female:big breasts', 900], ['female:big ass', 120]]);
    setTagCountOrderEnabled(false);

    expect(searchTags('big').map((item) => item.key)).toEqual(['big ass', 'big breasts']);
  });

  it('drops entries below the frequency floor instead of sorting them up', () => {
    // 4 次低于 TAG_COUNT_MIN_COUNT：这条频次不算数，于是与「没有数据」的 big ass
    // 同为 0，回到字母序。如果地板没生效，big breasts 会凭 4 次排到前面。
    installTagCounts([['female:big breasts', 4]]);
    setTagCountOrderEnabled(true);

    expect(searchTags('big').map((item) => item.key)).toEqual(['big ass', 'big breasts']);
  });
});
