import { z } from 'zod';


/** 同步账户：WebDAV 目录，或 S3 兼容对象存储（Cloudflare R2 等）。 */
export const SyncAccountKindSchema = z.enum(['webdav', 's3']);
export type SyncAccountKind = z.infer<typeof SyncAccountKindSchema>;

export const SyncAccountSchema = z.object({
  id: z.string().min(1),
  kind: SyncAccountKindSchema.default('webdav'),
  /** 同时只生效一套：同步、账户行与同步范围都看这一套。 */
  active: z.boolean().default(false),
  label: z.string().min(1),
  /** WebDAV：目录地址；S3：端点，如 https://<账号>.r2.cloudflarestorage.com。 */
  baseUrl: z.string().url(),
  /** 只有 S3 用得上：存储桶名。 */
  bucket: z.string().default(''),
  /** WebDAV：用户名；S3：Access Key ID。 */
  username: z.string(),
  credentialRef: z.string().min(1),
  /** 类别数组的 JSON；空串＝默认集合。解析用 domain/syncScope 的 parseSyncScope。 */
  syncScope: z.string(),
  status: z.string().min(1),
  lastProbeAt: z.string().nullable(),
  /** 上次成功同步的时刻（SQLite UTC 串）；空＝还没同步过。 */
  lastSyncAt: z.string().nullable().default(null),
  lastErrorCode: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type SyncAccount = z.infer<typeof SyncAccountSchema>;

export type SaveSyncAccountInput = {
  id: string;
  kind: SyncAccountKind;
  label: string;
  baseUrl: string;
  bucket: string;
  username: string;
  credential: string;
  /** 勾选的类别，JSON 数组字符串；缺省由原生侧回落默认集合。 */
  syncScope?: string;
};
