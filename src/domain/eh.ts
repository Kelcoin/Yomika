import { z } from 'zod';

export const EhAccountSchema = z.object({
  id: z.string().min(1), label: z.string().min(1), host: z.enum(['e-hentai.org', 'exhentai.org']),
  usernameHint: z.string().nullable().optional(), cookieRef: z.string().min(1), isActive: z.boolean(),
  status: z.enum(['unverified', 'verified', 'error']), createdAt: z.string(), updatedAt: z.string(),
  username: z.string().nullable().optional(),
  assets: z.object({ gp: z.string(), credits: z.string(), hath: z.string() }).nullable().optional(),
  exhentaiAccess: z.boolean().nullable().optional(),
});
export type EhAccount = z.infer<typeof EhAccountSchema>;
export const EhAccountStatusSchema = z.object({
  loggedIn: z.boolean(),
  username: z.string().nullable(),
  assets: z.object({ gp: z.string(), credits: z.string(), hath: z.string() }),
  exhentaiAccess: z.boolean().nullable(),
});
export type EhAccountStatus = z.infer<typeof EhAccountStatusSchema>;
export interface SaveEhAccountInput { id: string; label: string; host: 'e-hentai.org' | 'exhentai.org'; usernameHint?: string; cookie: string; }
