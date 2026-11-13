import { z } from 'zod';
import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';

export const AppSecurityStatusSchema = z.object({
  supported: z.boolean().default(true),
  locked: z.boolean(), passwordEnabled: z.boolean(), biometricEnabled: z.boolean(),
  lockOnBackground: z.boolean(), backgroundLockSeconds: z.number().int().optional(), hidePreview: z.boolean(), biometricAvailable: z.boolean(),
  previewProtectionAvailable: z.boolean(), platformNote: z.string().nullable().optional(),
  biometricLabel: z.string().optional(),
  credentialKind: z.enum(['password', 'pattern']).default('password'),
});
export type AppSecurityStatus = z.infer<typeof AppSecurityStatusSchema>;
export type AppSecurityConfig = { password?: string; currentPassword?: string; credentialKind?: 'password' | 'pattern'; biometricEnabled?: boolean; lockOnBackground?: boolean; backgroundLockSeconds?: number; hidePreview?: boolean };
const BootstrapSchema = z.object({ locked: z.boolean(), passwordEnabled: z.boolean(), biometricEnabled: z.boolean().default(false), credentialKind: z.enum(['password', 'pattern']) });
/** Only native document-start state may bypass an unconfigured startup gate. */
export function hasUnprotectedNativeBootstrap(): boolean {
  if (!hasNativeSecurity()) return false;
  const seed = (window as unknown as { __YOMIKA_SECURITY_BOOTSTRAP__?: unknown }).__YOMIKA_SECURITY_BOOTSTRAP__;
  const parsed = BootstrapSchema.safeParse(seed);
  return parsed.success && !parsed.data.passwordEnabled && !parsed.data.biometricEnabled && !parsed.data.locked;
}
export const hasNativeSecurity = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const appSecurityRepository = {
  status: () => invokeCommand('app_security_status', {}, AppSecurityStatusSchema),
  resume: () => invokeCommand('app_security_status', { foreground: true }, AppSecurityStatusSchema),
  configure: (config: AppSecurityConfig) => invokeCommand('app_security_configure', { config }, AppSecurityStatusSchema),
  unlockPassword: (password: string) => invokeCommand('app_security_unlock_password', { password }, AppSecurityStatusSchema),
  unlockBiometric: () => invokeCommand('app_security_unlock_biometric', {}, AppSecurityStatusSchema),
  lock: () => invokeCommand('app_security_lock', {}, AppSecurityStatusSchema),
  background: () => invokeCommand('app_security_background', {}, AppSecurityStatusSchema),
  ready: () => invokeCommand('app_security_ready', {}, VoidResponseSchema),
};
