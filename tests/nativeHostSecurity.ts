type Adapter = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * 每个原生宿主都得答的安全命令。老用例只关心别的原生路径（网页登录窗口、资源管理器
 * 定位、原生拖动），但 App 外壳每次挂载都会先问一次 `app_security_status`；不答就被
 * 「应用已锁定」整页盖住，连 `main` 都查不到。这里给一份「没开保护」的真实答复，让那些
 * 用例只验它们本来要验的事。安全设置自己的用例照旧自己接管这几个命令。
 */
export const UNLOCKED_APP_SECURITY = {
  supported: true, locked: false, passwordEnabled: false, biometricEnabled: false,
  lockOnBackground: false, hidePreview: false, biometricAvailable: false,
  previewProtectionAvailable: false, platformNote: null,
};

export function appSecurityReply(command: string): { ok: true; value: unknown } | undefined {
  if (command === 'app_security_status' || command === 'app_security_lock' || command === 'app_security_background') {
    return { ok: true, value: UNLOCKED_APP_SECURITY };
  }
  if (command === 'app_security_ready') return { ok: true, value: null };
  return undefined;
}

export function withAppSecurity(adapter: Adapter): Adapter {
  return (command, args) => {
    const reply = appSecurityReply(command);
    return reply ? Promise.resolve(reply) : adapter(command, args);
  };
}
