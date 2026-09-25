import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DATA_TRANSFER_SCOPE,
  TRANSFER_CREDENTIAL_CATEGORIES,
  TRANSFER_RECORD_CATEGORIES,
  credentialScopeLabel,
  exportScopeLabel,
  credentialTransferScope,
  parseDataTransferScope,
  recordTransferScope,
  transferScopeLabel,
} from '../../src/domain/dataTransferScope';

/** 导入导出范围与同步范围是两份清单：前者决定文件里装什么（凭据可勾），后者决定
 * 什么自动流动（凭据不在）。这里钉住前者自己的规则。 */
describe('data transfer scope', () => {
  it('defaults to the record classes and leaves the credential classes out', () => {
    expect([...DEFAULT_DATA_TRANSFER_SCOPE]).toEqual(TRANSFER_RECORD_CATEGORIES.map((entry) => entry.id));
    for (const category of TRANSFER_CREDENTIAL_CATEGORIES) {
      expect(DEFAULT_DATA_TRANSFER_SCOPE).not.toContain(category.id);
    }
  });

  it('drops unknown ids but keeps a deliberate empty choice empty', () => {
    // 改过名的 id（favorites / credentials）读回来丢掉。
    expect(parseDataTransferScope(['history', 'favorites', 'credentials', 'lrr_servers']))
      .toEqual(['history', 'lrr_servers']);
    // 没存过（undefined）＝用默认集合；存着空数组＝使用者明确一类都不要。
    expect(parseDataTransferScope(undefined)).toEqual([...DEFAULT_DATA_TRANSFER_SCOPE]);
    expect(parseDataTransferScope([])).toEqual([]);
  });

  it('splits the two halves for the two files', () => {
    const scope = parseDataTransferScope(['history', 'dedup', 'lrr_servers', 'sync_accounts']);
    // 记录那一半喂 export_scoped_data / import_scoped_data。
    expect(recordTransferScope(scope)).toEqual(['history', 'dedup']);
    // 凭据那一半喂 export_credentials / import_credentials。
    expect(credentialTransferScope(scope)).toEqual(['lrr_servers', 'sync_accounts']);
  });

  it('answers only whether credentials ride along, in a value short enough for one row', () => {
    // 值不换行也不截断（.settings-row-value），长值会把标签挤成两行——手机上默认那个
    // 状态最常被看到，它得是最短的。哪几类记录由「导出数据」那一行逐个列名字，这里
    // 再数一遍只会把值撑长。
    expect(transferScopeLabel([...DEFAULT_DATA_TRANSFER_SCOPE])).toBe('仅记录与设置');
    expect(transferScopeLabel([...TRANSFER_CREDENTIAL_CATEGORIES.map((entry) => entry.id)])).toBe('仅凭据');
    expect(transferScopeLabel(['history', 'lrr_servers'])).toBe('记录与设置 + 凭据');
    expect(transferScopeLabel([])).toBe('什么都没勾');
    for (const scope of [DEFAULT_DATA_TRANSFER_SCOPE, TRANSFER_CREDENTIAL_CATEGORIES.map((entry) => entry.id), ['history', 'lrr_servers'], []] as const) {
      // 10 = 「记录与设置 + 凭据」，实测这一档在 390 宽下标签仍是一行。
      expect(transferScopeLabel(scope).length).toBeLessThanOrEqual(10);
    }
  });

  it('says on the export row that a passphrase will be needed', () => {
    // 「导出数据」那一行：记录的名字照列，勾了凭据就补一句——那份文件会先要口令。
    expect(exportScopeLabel([...DEFAULT_DATA_TRANSFER_SCOPE])).toBe('全部记录与设置');
    expect(exportScopeLabel(['history', 'dedup'])).toBe('历史、非重复标记');
    expect(exportScopeLabel(['history', 'lrr_servers'])).toBe('历史 + 凭据');
    expect(exportScopeLabel([...TRANSFER_CREDENTIAL_CATEGORIES.map((entry) => entry.id)])).toBe('仅凭据');
    expect(exportScopeLabel([])).toBe('未选择记录与设置');
  });

  it('lists the credential classes by name for the passphrase dialog', () => {
    expect(credentialScopeLabel(['lrr_servers', 'sync_accounts'])).toBe('LRR 服务器、同步账户');
    expect(credentialScopeLabel([...DEFAULT_DATA_TRANSFER_SCOPE])).toBe('');
  });
});
