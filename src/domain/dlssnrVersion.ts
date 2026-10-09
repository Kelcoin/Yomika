/** 「装的这一份片段是哪一版」——设置页显示版本号时用的那两句话。
 *
 * 版本号来自后端读文件自己的版本资源（`nvngx_dlssnr.dll` 的 VERSIONINFO，Windows
 * 属性页里那一串）。读不出来就是 `null`，那时**什么都不加**：写一句「未知」会与
 * 「还没有片段」混在一起，比不写更糟。
 *
 * 分隔符只在这里出现一次，所以两处显示（「DLSSNR 组件」那一行的值、开关那一行的说明）
 * 不会一处用 `·`、一处用空格。 */

/** 版本号那半句（读不出来就是空串）。 */
export function dllVersionSuffix(version: string | null | undefined): string {
  return version ? ` · ${version}` : '';
}

/** 「哪一份 + 哪一版」：变体认不出来时用调用方给的兜底名（`未安装` / 变体 id / `自定义 DLL`）。 */
export function installedDllLabel(
  variantLabel: string | null | undefined,
  fallback: string,
  version: string | null | undefined,
): string {
  return `${variantLabel ?? fallback}${dllVersionSuffix(version)}`;
}
