import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DATA_TRANSFER_SCOPE,
  TRANSFER_CREDENTIAL_CATEGORIES,
  TRANSFER_RECORD_CATEGORIES,
  credentialScopeLabel,
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

  it('says in one line what a file would carry', () => {
    expect(transferScopeLabel([...DEFAULT_DATA_TRANSFER_SCOPE])).toBe('记录与设置全选 · 不含凭据');
    expect(transferScopeLabel([...TRANSFER_CREDENTIAL_CATEGORIES.map((entry) => entry.id)]))
      .toBe('不含记录与设置 · 含全部凭据');
    expect(transferScopeLabel(['history', 'lrr_servers'])).toBe('记录与设置 1 项 · 凭据 1 项');
    expect(transferScopeLabel([])).toBe('不含记录与设置 · 不含凭据');
  });

  it('lists the credential classes by name for the passphrase dialog', () => {
    expect(credentialScopeLabel(['lrr_servers', 'sync_accounts'])).toBe('LRR 服务器、同步账户');
    expect(credentialScopeLabel([...DEFAULT_DATA_TRANSFER_SCOPE])).toBe('');
  });
});
