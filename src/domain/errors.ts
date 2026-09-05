import { z } from 'zod';

export const DomainErrorCodeSchema = z.enum([
  'UNKNOWN',
  'INVALID_RESPONSE',
  'PLATFORM_UNAVAILABLE',
  'LRR_UNAUTHORIZED',
  'LRR_NOT_FOUND',
  'REMOTE_CONFLICT',
  'REMOTE_RATE_LIMIT',
  'REMOTE_UNAVAILABLE',
  'SYNC_MANIFEST_CONFLICT',
  'INFERENCE_UNAVAILABLE',
  'CACHE_QUOTA_EXCEEDED',
  'EH_UNAUTHORIZED',
  /** A sign-in attempt was refused. Distinct from EH_REAUTH_REQUIRED, which
   * means a stored session stopped working: telling someone their login had
   * expired on their first attempt is a contradiction. */
  'EH_LOGIN_REJECTED',
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
