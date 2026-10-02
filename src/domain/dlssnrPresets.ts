import type { DlssnrPass } from '../repositories/nativeDlssnrRepository';

/** 3D CG 图片的三套预设：都是同一张图串行跑的层数不同（1 / 3 / 5）。
 *
 *  取值是按本机量出来的取向定的，不是规范：3D CG 是干净渲染图，DLSSNR 每多跑一层就
 *  会在平滑面上多留一点颗粒——同一张 1500×2000 的样张上，「最平坦的 5% 区域噪声」这一
 *  项，1 层 ×1.03、3 层 ×1.13、5 层 ×1.17；而「层层都开着结构」的写法能到 ×1.4–1.8，
 *  脸上直接起斑。所以这里三套都是**第一层出主要效果、后面的层逐级收窄**：强度往下让、
 *  色调递减、结构减半，把一次重手拆成几次轻手。
 *
 *  换了片段或换了画风，这三个数要重新量（记录在 `docs/68`）。 */
export interface DlssnrPreset {
  readonly id: string;
  readonly label: string;
  /** 菜单里跟在名字下面的那句话：说清它是什么，而不是「预设 1」。 */
  readonly note: string;
  readonly passes: ReadonlyArray<DlssnrPass>;
}

/** 只写这次的三个变量，其余字段取「什么都不额外做」：风格 0、皮肤结构 0、
 *  自动遮罩与界面修正关——预设要管的是强度，别的旋钮留给用户自己开。 */
const pass = (intensity: number, localToneStrength: number, localStructureStrength: number): DlssnrPass => ({
  style: 0,
  intensity,
  localToneStrength,
  localStructureStrength,
  skinStructureStrength: 0,
  autoMask: false,
  uiCorrection: false,
});

export const DLSSNR_PRESETS: ReadonlyArray<DlssnrPreset> = [
  {
    id: 'cg-light',
    label: '轻度',
    note: '1 层 · 只去噪，几乎不动细节',
    passes: [pass(1, 0, 0.5)],
  },
  {
    id: 'cg-standard',
    label: '标准',
    note: '3 层 · 细节与结构',
    passes: [pass(1, 0.3, 0.8), pass(0.7, 0.15, 0.4), pass(0.5, 0.1, 0.2)],
  },
  {
    id: 'cg-strong',
    label: '强化',
    note: '5 层 · 纹理与结构最强',
    passes: [
      pass(1, 0.4, 0.8),
      pass(0.8, 0.2, 0.5),
      pass(0.6, 0.15, 0.35),
      pass(0.5, 0.1, 0.25),
      pass(0.4, 0.1, 0.15),
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
