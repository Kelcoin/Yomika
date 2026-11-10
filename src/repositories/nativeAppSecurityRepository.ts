import { z } from 'zod';
import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';

export const AppSecurityStatusSchema = z.object({
  supported: z.boolean().default(true),
  locked: z.boolean(), passwordEnabled: z.boolean(), biometricEnabled: z.boolean(),
  lockOnBackground: z.boolean(), hidePreview: z.boolean(), biometricAvailable: z.boolean(),
  previewProtectionAvailable: z.boolean(), platformNote: z.string().nullable().optional(),
  biometricLabel: z.string().optional(),
});
export type AppSecurityStatus = z.infer<typeof AppSecurityStatusSchema>;
export type AppSecurityConfig = { password?: string; currentPassword?: string; biometricEnabled?: boolean; lockOnBackground?: boolean; hidePreview?: boolean };
export const hasNativeSecurity = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const appSecurityRepository = {
  status: () => invokeCommand('app_security_status', {}, AppSecurityStatusSchema),
  configure: (config: AppSecurityConfig) => invokeCommand('app_security_configure', { config }, AppSecurityStatusSchema),
  unlockPassword: (password: string) => invokeCommand('app_security_unlock_password', { password }, AppSecurityStatusSchema),
  unlockBiometric: () => invokeCommand('app_security_unlock_biometric', {}, AppSecurityStatusSchema),
  lock: () => invokeCommand('app_security_lock', {}, AppSecurityStatusSchema),
  background: () => invokeCommand('app_security_background', {}, AppSecurityStatusSchema),
  ready: () => invokeCommand('app_security_ready', {}, VoidResponseSchema),
};
