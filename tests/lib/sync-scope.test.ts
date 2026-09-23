import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SYNC_SCOPE,
  SELECTABLE_SYNC_SCOPE,
  SYNC_SCOPE_CATEGORIES,
  parseSyncScope,
  scopeLabel,
  scopeSummary,
} from '../../src/domain/syncScope';

/** 同步范围这份表就是「什么会自动在设备之间流动」的唯一名单。凭据不在里面：它们只
 * 在本机，由「导入导出范围」单独管（见 data-transfer-scope.test.ts）。 */
describe('sync scope', () => {
  it('holds only records and settings, and defaults to all of them', () => {
    expect([...DEFAULT_SYNC_SCOPE]).toEqual([
      'progress',
      'history',
      'watchlist',
      'search_presets',
      'dedup',
      'app_settings',
    ]);
    expect([...SELECTABLE_SYNC_SCOPE]).toEqual([...DEFAULT_SYNC_SCOPE]);
    // 凭据类不是同步类别：它们在「导入导出范围」里，同步这边连 id 都不该认识。
    const ids = SYNC_SCOPE_CATEGORIES.map((entry) => entry.id);
    for (const retired of ['credentials', 'lrr_servers', 'eh_account', 'sync_accounts', 'favorites']) {
      expect(ids).not.toContain(retired);
    }
  });

  it('drops the credential ids an older account may have stored', () => {
    // 老账户里存着 lrr_servers / eh_account / credentials：读回来必须丢掉，否则界面
    // 会说这份范围同步了凭据，而原生侧一件都不会推。
    expect(parseSyncScope('["progress","lrr_servers","eh_account","credentials"]')).toEqual(['progress']);
    // 只剩那些＝没有可同步的类别，回落到默认集合。
    expect(parseSyncScope('["credentials"]')).toEqual([...DEFAULT_SYNC_SCOPE]);
  });

  it('falls back to the default set for empty or unknown values', () => {
    expect(parseSyncScope(undefined)).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('')).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('[]')).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('not json')).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('{"progress":true}')).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('["nonsense"]')).toEqual([...DEFAULT_SYNC_SCOPE]);
  });

  it('names the whole selectable set as records and settings, never "all data"', () => {
    // 「全部数据」把凭据说进来了——它们不在同步里，所以全勾也只敢说记录与设置。
    expect(scopeLabel([...SELECTABLE_SYNC_SCOPE])).toBe('记录与设置全选');
    expect(scopeLabel(['history', 'dedup'])).toBe('历史、非重复标记');
    expect(scopeLabel([])).toBe('不同步任何数据');
    expect(scopeSummary('["history"]')).toBe('同步：历史');
  });
});
