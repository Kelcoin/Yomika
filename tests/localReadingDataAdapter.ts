import { setInvokeAdapterForTests as install } from '../src/bridge/invoke';
import { invalidateLrrBridgeConfig } from '../src/repositories/nativeLrrBridgeRepository';
import { appSecurityReply } from './nativeHostSecurity';
/** Legacy UI fixtures explicitly use local reading data. Hosted suites use the real adapter. */
export function setInvokeAdapterForTests(adapter: Parameters<typeof install>[0]) {
  invalidateLrrBridgeConfig();
  install((command, args) => {
    const security = appSecurityReply(command);
    if (security) return Promise.resolve(security);
    return command === 'lrr_bridge_config'
      ? Promise.resolve({ ok: true, value: { enabled: false, pending: 0, conflicts: 0 } })
      : adapter(command, args);
  });
}
