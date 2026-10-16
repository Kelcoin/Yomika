import type { z } from 'zod';

/** Display snapshots are optional: obsolete or damaged data must never stop a
 * page from rendering before its authoritative native read can finish. */
export function readStorageSnapshot<S extends z.ZodTypeAny>(key: string, schema: S): z.output<S> | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null'));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}
