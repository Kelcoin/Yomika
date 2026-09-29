import { z } from 'zod';

export const DomainErrorCodeSchema = z.enum([
  'UNKNOWN',
  'INVALID_RESPONSE',
  'INVALID_INPUT',
  'INVALID_MANIFEST',
  'INVALID_MODEL_IMPORT',
  'MODEL_MANIFEST_FETCH_FAILED',
  'MODEL_ALREADY_EXISTS',
  'MODEL_DOWNLOAD_FAILED',
  'MODEL_ACTIVATION_FAILED',
  'PLATFORM_UNAVAILABLE',
  'LRR_UNAUTHORIZED',
  'LRR_NOT_FOUND',
  'REMOTE_CONFLICT',
  'REMOTE_RATE_LIMIT',
  'REMOTE_UNAVAILABLE',
  'SYNC_MANIFEST_CONFLICT',
  'INFERENCE_UNAVAILABLE',
  /** 这一页的推理被取消了（切页、关开关、离开阅读器）。不是失败：取消的结果既
   * 不该进错误日志，也不该写进任何缓存。 */
  'INFERENCE_CANCELLED',
  /** 远端那一台超时没回话：可重试，本地会退到本机那一版继续读。 */
  'REMOTE_TIMEOUT',
  'CACHE_QUOTA_EXCEEDED',
  'EH_UNAUTHORIZED',
  /** A sign-in attempt was refused. Distinct from EH_REAUTH_REQUIRED, which
   * means a stored session stopped working: telling someone their login had
   * expired on their first attempt is a contradiction. */
  'EH_LOGIN_REJECTED',
  // The sign-in window was closed before a session appeared, which is how
  // someone gives up on the web login.
  'EH_LOGIN_WINDOW_CLOSED',
  'EH_REAUTH_REQUIRED',
  'EH_RATE_LIMIT',
  'EH_CLOUDFLARE',
  'EH_ACCESS_BLOCKED',
  'EH_CONTENT_WARNING',
  'EH_GALLERY_DELETED',
  'EH_GALLERY_COPYRIGHT_REMOVED',
  'EH_EMPTY_RESPONSE',
  'EH_UNEXPECTED_PAGE',
  'EH_UNAVAILABLE',
  /** 原生侧已经在用的几个码，之前没进这张表：任何一处发出它们，整条错误都会被桥
   * 当成「无效响应」，真正的信息（比如 WebDAV 连不上）反而看不到。 */
  'NETWORK',
  'NOT_FOUND',
  'LOCAL_DATABASE',
  /** 模型仓库那份目录拿不到（离线、镜像挂了）。目录只在设置页用，拿不到就该显示
   * 「列不出来」，而不是把所有模型列表一起弄空。 */
  'MODEL_CATALOG_FETCH_FAILED',
]);

export type DomainErrorCode = z.infer<typeof DomainErrorCodeSchema>;

export interface DomainError {
  code: DomainErrorCode;
  message: string;
  retryable: boolean;
}

export const DomainErrorSchema: z.ZodType<DomainError> = z.object({
  code: DomainErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
