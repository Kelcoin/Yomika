import { z } from 'zod';


export const WebdavAccountSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  baseUrl: z.string().url(),
  username: z.string(),
  credentialRef: z.string().min(1),
  /** 类别数组的 JSON；空串＝默认集合。解析用 domain/syncScope 的 parseSyncScope。 */
  syncScope: z.string(),
  status: z.string().min(1),
  lastProbeAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type WebdavAccount = z.infer<typeof WebdavAccountSchema>;

export type SaveWebdavAccountInput = {
  id: string;
  label: string;
  baseUrl: string;
  username: string;
  credential: string;
  /** 勾选的类别，JSON 数组字符串；缺省由原生侧回落默认集合。 */
  syncScope?: string;
};
