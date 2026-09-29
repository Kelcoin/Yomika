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

/** 这台机器此刻能不能跑 DLSSNR。
 *
 * `preferences.dlssnrEnabled` 只说明「用户想用」，而它是**持久化**的：昨天在台式机上
 * 打开过、今天换到没有 N 卡的机器上照样是 true。阅读器据此排队会反复调用一个跑不起来的东西（每次都是一次原生失败 + 一条
 * 日志），所以排队之前先问原生这一句。
 *
 * 这一句是**便宜**的：原生只读缓存的显卡信息、看文件在不在，不建 D3D12
 * 设备、不跑 NGX。
 *
 * 可选检测不参与运行门控；真正推理失败由原生处理链返回。 */
export async function checkDlssnrAvailability(preferenceEnabled: boolean): Promise<DlssnrAvailability> {
  if (!preferenceEnabled) return { ready: false, disable: false };
  const result = await repository.status();
  if (!result.ok) return { ready: false, reason: result.error.message, disable: false };
  const status = result.value;
  if (!status.available) {
    return { ready: false, reason: status.error ?? '这台机器现在跑不了 DLSSNR', disable: true };
  }
  return { ready: true, disable: false };
}
