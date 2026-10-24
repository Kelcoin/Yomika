import type { DlssnrPass } from '../repositories/nativeDlssnrRepository';

/** 三套渐进增强预设（1 / 3 / 5 层）：后续层逐渐减弱，避免反复增强平坦区域。 */
export interface DlssnrPreset {
  readonly id: string;
  readonly label: string;
  /** 菜单里跟在名字下面的那句话：说清它是什么，而不是「预设 1」。 */
  readonly note: string;
  readonly passes: ReadonlyArray<DlssnrPass>;
}

/** 保留皮肤的柔和质感，默认启用区域遮罩与界面保护。 */
const pass = (intensity: number, localToneStrength: number, localStructureStrength: number): DlssnrPass => ({
  style: 0,
  intensity,
  localToneStrength,
  localStructureStrength,
  skinStructureStrength: 0,
  autoMask: true,
  uiCorrection: true,
});

export const DLSSNR_PRESETS: ReadonlyArray<DlssnrPreset> = [
  {
    id: 'cg-light',
    label: '轻度',
    note: '1 层 · 柔和去噪与色调',
    passes: [pass(1, 0.15, 0.5)],
  },
  {
    id: 'cg-standard',
    label: '标准',
    note: '3 层 · 细节与结构',
    passes: [pass(1, 0.5, 0.8), pass(0.85, 0.3, 0.4), pass(0.65, 0.2, 0.2)],
  },
  {
    id: 'cg-strong',
    label: '强化',
    note: '5 层 · 纹理与结构最强',
    passes: [
      pass(1, 0.65, 0.8),
      pass(0.95, 0.4, 0.5),
      pass(0.8, 0.3, 0.35),
      pass(0.65, 0.2, 0.25),
      pass(0.55, 0.15, 0.15),
    ],
  },
];

/** 当前层参数正好等于哪一套预设（用来在菜单里标「当前」）。数值本质上只有一位小数，
 *  但滑杆给的是浮点，所以按 1e-6 比，不是按相等比。 */
export function presetOf(passes: ReadonlyArray<DlssnrPass>): string | undefined {
  const same = (left: DlssnrPass, right: DlssnrPass) =>
    left.style === right.style &&
    left.autoMask === right.autoMask &&
    left.uiCorrection === right.uiCorrection &&
    Math.abs(left.skinStructureStrength - right.skinStructureStrength) < 1e-6 &&
    Math.abs(left.intensity - right.intensity) < 1e-6 &&
    Math.abs(left.localToneStrength - right.localToneStrength) < 1e-6 &&
    Math.abs(left.localStructureStrength - right.localStructureStrength) < 1e-6;
  return DLSSNR_PRESETS.find((preset) =>
    preset.passes.length === passes.length && preset.passes.every((layer, index) => same(layer, passes[index]!)))?.id;
}
