import { z } from 'zod';

export const EhAccountSchema = z.object({
  id: z.string().min(1), label: z.string().min(1), host: z.enum(['e-hentai.org', 'exhentai.org']),
  usernameHint: z.string().nullable().optional(), cookieRef: z.string().min(1), isActive: z.boolean(),
  status: z.enum(['unverified', 'verified', 'error']), createdAt: z.string(), updatedAt: z.string(),
});
export type EhAccount = z.infer<typeof EhAccountSchema>;
export interface SaveEhAccountInput { id: string; label: string; host: 'e-hentai.org' | 'exhentai.org'; usernameHint?: string; cookie: string; }
