import { NativeDlssnrRepository } from '../repositories/nativeDlssnrRepository';

const repository = new NativeDlssnrRepository();

export interface DlssnrAvailability {
  /** 这一刻可以排队跑：显卡、片段、核心都在，而且没有任何一条已知的「跑不起来」的证据。 */
  ready: boolean;
  /** 不能跑时说清楚差什么（给 toast 用）。 */
  reason?: string;
  /** 要不要把偏好里的开关写回 false。
   *
   * 只在**拿到了一份确定说「跑不起来」的现状**时才写回。问不到现状（命令失败、平台不
   * 支持）时不写：那说明不了这台机器不行，而偏好在设备之间是同步的——手机把桌面端刚
   * 打开的开关关掉，是不该发生的事。 */
  disable: boolean;
}

/** 这台机器此刻能不能跑 DLSS5。
 *
 * `preferences.dlssnrEnabled` 只说明「用户想用」，而它是**持久化**的：昨天在台式机上
 * 打开过、今天换到没有 N 卡的机器上照样是 true；换过 DLL 之后旧的那次检测结论也还留在
 * 设置里。阅读器据此排队会反复调用一个跑不起来的东西（每次都是一次原生失败 + 一条
 * 日志），所以排队之前先问原生这一句。
 *
 * 这一句是**便宜**的：原生只枚举显卡、看文件在不在、比对上次检测的时间戳，不建 D3D12
 * 设备、不跑 NGX。
 *
 * 「没有结论」与「结论是跑不起来」是两件事：前者（重开一次应用之后探针本来就不在了）
 * 照样放行——开关只有在检测通过过之后才可能被打开；后者才拦。 */
export async function checkDlssnrAvailability(preferenceEnabled: boolean): Promise<DlssnrAvailability> {
  if (!preferenceEnabled) return { ready: false, disable: false };
  const result = await repository.status();
  if (!result.ok) return { ready: false, reason: result.error.message, disable: false };
  const status = result.value;
  if (!status.available) {
    return { ready: false, reason: status.error ?? '这台机器现在跑不了 DLSS5', disable: true };
  }
  // Native execution requires a successful probe for this exact DLL in the
  // current process. A persisted preference must not bypass that requirement
  // after restart, DLL replacement, or driver changes.
  if (!status.probe || !status.probeValid) {
    return {
      ready: false,
      reason: status.probe
        ? (status.probe.error ?? '上次检测没有通过，请重新检测')
        : '这台机器还没有检测过，请在设置页先检测一次',
      disable: true,
    };
  }
  if (!status.probe.supported) {
    return { ready: false, reason: status.probe.error ?? '上次检测没有通过', disable: true };
  }
  return { ready: true, disable: false };
}
