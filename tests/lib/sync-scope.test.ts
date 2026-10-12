import { describe, expect, it } from 'vitest';

import {
  DATA_EXPORT_RECORD_ITEMS,
  DEFAULT_DATA_EXPORT_ITEMS,
} from '../../src/domain/dataExport';
import {
  DEFAULT_SYNC_SCOPE,
  SELECTABLE_SYNC_SCOPE,
  SYNC_SCOPE_CATEGORIES,
  parseSyncScope,
  scopeLabel,
  scopeSummary,
} from '../../src/domain/syncScope';

/** 同步范围这份表就是「什么会自动在设备之间流动」的唯一名单。凭据不在里面：它们只
 * 在本机，由「导入导出范围」单独管（见 data-transfer-scope.test.ts）。应用设置也不在
 * 里面：主题与后处理开关是「这台机器怎么用」，同步只会让两台设备互相覆盖——它跟着
 * 显式导出文件走，所以这份表与 `DATA_EXPORT_RECORD_ITEMS` 刻意不再互为镜像。 */
describe('sync scope', () => {
  it('holds only records, and defaults to all of them', () => {
    expect([...DEFAULT_SYNC_SCOPE]).toEqual([
      'progress',
      'history',
      'watchlist',
      'search_presets',
      'dedup',
    ]);
    expect([...SELECTABLE_SYNC_SCOPE]).toEqual([...DEFAULT_SYNC_SCOPE]);
    // 凭据类不是同步类别：它们在「导入导出范围」里，同步这边连 id 都不该认识。
    const ids = SYNC_SCOPE_CATEGORIES.map((entry) => entry.id);
    for (const retired of ['credentials', 'lrr_servers', 'eh_account', 'sync_accounts', 'favorites']) {
      expect(ids).not.toContain(retired);
    }
    // 应用设置也不是同步类别了。本地存一次偏好就写一条 app_setting 日志，勾着它同步
    // 的两台设备会互相覆盖主题与后处理开关（用户看到的是主题来回跳、DLSSNR 自己关掉）。
    expect(ids).not.toContain('app_settings');
  });

  it('keeps app settings in the export list, which no longer mirrors sync', () => {
    // 摘出同步不等于也摘出文件：换机器带走设置只有这一条路。清单必须自己列全，
    // 一旦有人把它改回从 SYNC_SCOPE_CATEGORIES 派生，这条就转红。
    expect(DATA_EXPORT_RECORD_ITEMS.map((item) => item.id)).toEqual([
      'progress',
      'history',
      'watchlist',
      'search_presets',
      'dedup',
      'app_settings',
    ]);
    expect(DEFAULT_DATA_EXPORT_ITEMS).toEqual(DATA_EXPORT_RECORD_ITEMS.map((item) => item.id));
  });

  it('drops the ids an older account may have stored', () => {
    // 老账户里存着 lrr_servers / eh_account / credentials：读回来必须丢掉，否则界面
    // 会说这份范围同步了凭据，而原生侧一件都不会推。
    expect(parseSyncScope('["progress","lrr_servers","eh_account","credentials"]')).toEqual(['progress']);
    // 存过「应用设置」的老账户同理：它已经不属于同步范围。
    expect(parseSyncScope('["progress","app_settings"]')).toEqual(['progress']);
    // 只剩那些＝没有可同步的类别，回落到默认集合（不能变成「不同步任何数据」）。
    expect(parseSyncScope('["credentials"]')).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('["app_settings"]')).toEqual([...DEFAULT_SYNC_SCOPE]);
  });

  it('falls back to the default set for empty or unknown values', () => {
    expect(parseSyncScope(undefined)).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('')).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('[]')).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('not json')).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('{"progress":true}')).toEqual([...DEFAULT_SYNC_SCOPE]);
    expect(parseSyncScope('["nonsense"]')).toEqual([...DEFAULT_SYNC_SCOPE]);
  });

  it('names the whole selectable set as records, never "all data"', () => {
    // 「全部数据」把凭据与应用设置都说进来了——凭据只在本机、应用设置只跟着导出文件
    // 走，所以全勾也只敢说记录。
    expect(scopeLabel([...SELECTABLE_SYNC_SCOPE])).toBe('记录全选');
    expect(scopeLabel(['history', 'dedup'])).toBe('历史、非重复标记');
    expect(scopeLabel([])).toBe('不同步任何数据');
    expect(scopeSummary('["history"]')).toBe('同步：历史');
  });
});
