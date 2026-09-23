/** 导入导出范围：手动带走的文件里装哪几类。
 *
 * 它与**同步范围无关**：同步范围管「哪些数据在设备之间自动流动」，这一份管「我这次
 * 要带走什么」。两者分开是因为它们答的不是同一个问题——同步永远不带凭据（同步密钥
 * 由账户口令派生，写进远端文档等于把钥匙一起交出去），而换台机器偏偏需要凭据，所以
 * 凭据在这里是可勾的，在同步那边连类别都没有。
 *
 * 这是 Rust 侧 `data_transfer` 那份词表的镜像。记录类的 id 与同步范围同名，因为命名
 * 的是同一批数据；但这是两份清单，新增一类记录时两处都要动。
 */
export const TRANSFER_RECORD_CATEGORIES = [
  { id: 'progress', label: '阅读进度' },
  { id: 'history', label: '历史' },
  { id: 'watchlist', label: '待看' },
  { id: 'search_presets', label: '搜索预设' },
  { id: 'dedup', label: '非重复标记' },
  { id: 'app_settings', label: '应用设置' },
] as const;

/** 凭据类：随口令加密的凭据文件走（导出时要另外设口令）。 */
export const TRANSFER_CREDENTIAL_CATEGORIES = [
  { id: 'lrr_servers', label: 'LRR 服务器' },
  { id: 'eh_account', label: 'E-H 账户' },
  { id: 'sync_accounts', label: '同步账户' },
] as const;

export type TransferRecordCategory = (typeof TRANSFER_RECORD_CATEGORIES)[number]['id'];
export type TransferCredentialCategory = (typeof TRANSFER_CREDENTIAL_CATEGORIES)[number]['id'];
export type TransferCategory = TransferRecordCategory | TransferCredentialCategory;

/** 默认：记录与设置全勾，凭据不勾——带凭据的文件要额外设口令，该是一次明确的选择，
 * 而不是默认就发生在「导出」按钮上。 */
export const DEFAULT_DATA_TRANSFER_SCOPE: readonly TransferCategory[] =
  TRANSFER_RECORD_CATEGORIES.map((entry) => entry.id);

const RECORD_IDS = new Set<string>(TRANSFER_RECORD_CATEGORIES.map((entry) => entry.id));
const CREDENTIAL_IDS = new Set<string>(TRANSFER_CREDENTIAL_CATEGORIES.map((entry) => entry.id));
const ALL_IDS = new Set<string>([...RECORD_IDS, ...CREDENTIAL_IDS]);

/** 存着的是 id 数组；未知条目丢掉（改过名的 id 不该留在勾选里）。**空就是空**：
 * 「一类都不勾」是明确的选择，回落到默认会让它在下次保存时又勾回来。新建的库由
 * 原生侧的默认值给出那份默认集合。 */
export function parseDataTransferScope(value: readonly string[] | undefined): TransferCategory[] {
  if (!value) return [...DEFAULT_DATA_TRANSFER_SCOPE];
  return value.filter((item): item is TransferCategory => ALL_IDS.has(item));
}

export function isCredentialCategory(id: string): id is TransferCredentialCategory {
  return CREDENTIAL_IDS.has(id);
}

/** 记录与设置那一半：喂给 `export_scoped_data` / `import_scoped_data`。 */
export function recordTransferScope(scope: readonly TransferCategory[]): TransferRecordCategory[] {
  return scope.filter((item): item is TransferRecordCategory => RECORD_IDS.has(item));
}

/** 凭据那一半：喂给 `export_credentials` / `import_credentials`。 */
export function credentialTransferScope(scope: readonly TransferCategory[]): TransferCredentialCategory[] {
  return scope.filter((item): item is TransferCredentialCategory => CREDENTIAL_IDS.has(item));
}

/** 记录那一半的名字，用在「导出数据」那一行上：文件里装的就是这一半。 */
export function recordScopeLabel(scope: readonly TransferCategory[]): string {
  const records = recordTransferScope(scope);
  if (records.length === TRANSFER_RECORD_CATEGORIES.length) return '全部记录与设置';
  const labels = TRANSFER_RECORD_CATEGORIES.filter((entry) => records.includes(entry.id)).map((entry) => entry.label);
  return labels.length > 0 ? labels.join('、') : '未选择记录与设置';
}

/** 面板行上的摘要：两半各自选了几类，一眼看得出文件里有没有凭据。 */
export function transferScopeLabel(scope: readonly TransferCategory[]): string {
  const records = recordTransferScope(scope).length;
  const credentials = credentialTransferScope(scope).length;
  const recordText = records === TRANSFER_RECORD_CATEGORIES.length
    ? '记录与设置全选'
    : records === 0
      ? '不含记录与设置'
      : `记录与设置 ${records} 项`;
  const credentialText = credentials === 0
    ? '不含凭据'
    : credentials === TRANSFER_CREDENTIAL_CATEGORIES.length
      ? '含全部凭据'
      : `凭据 ${credentials} 项`;
  return `${recordText} · ${credentialText}`;
}

/** 勾了哪几类的名字，用来在口令对话框里说清「这个文件里装了什么」。 */
export function credentialScopeLabel(scope: readonly TransferCategory[]): string {
  return TRANSFER_CREDENTIAL_CATEGORIES
    .filter((entry) => scope.includes(entry.id))
    .map((entry) => entry.label)
    .join('、');
}
