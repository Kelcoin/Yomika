import type { InstalledModel, UpscaleCatalogModel } from '../repositories/nativeInferenceRepository';

export interface AvailableModelUpdate {
  id: string;
  /** 目录里的名字，比按 id 拼出来的名字准确。 */
  label: string;
  installedVersion: string;
  availableVersion: string;
}

/** 盘上每个 id 只留最新那一版。
 *
 * 后端按版本倒序列出记录（`installed_models_in`），而一行选项的值是 id，所以同一个
 * 模型的两个版本会渲成两行一模一样的选项。 */
function newestPerId(models: InstalledModel[]): InstalledModel[] {
  const seen = new Set<string>();
  const newest: InstalledModel[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    newest.push(model);
  }
  return newest;
}

/** 目录里报了新版本、盘上那份还是旧版本的超分模型。
 *
 * 两边都拿到才比：目录拉不到（离线）时什么都不报，装了但不在目录里的模型（内置
 * Anime4K、导入的模型）也不属于「更新」——没有更新的目标版本可参照。
 *
 * 只有带 `scale` 的记录算数：没有 manifest 的目录列出来了也跑不起来，而下载好的
 * 才是我们比较的对象。 */
export function availableModelUpdates(
  installed: InstalledModel[] | undefined,
  catalog: UpscaleCatalogModel[] | undefined,
): AvailableModelUpdate[] {
  if (!installed?.length || !catalog?.length) return [];
  const hosted = new Map(catalog.map((model) => [model.id, model] as const));
  const updates: AvailableModelUpdate[] = [];
  for (const model of newestPerId(installed.filter((entry) => entry.scale && entry.kind === 'upscale'))) {
    const available = hosted.get(model.id);
    if (!available || available.version === model.version) continue;
    updates.push({
      id: model.id,
      label: available.label,
      installedVersion: model.version,
      availableVersion: available.version,
    });
  }
  return updates;
}

/** 「跳过这次」记下来的指纹。
 *
 * 模型这套没有单一版本号：一次可能有几颗模型同时更新，所以记的是「id@目标版本」
 * 排序后的串——过两天再来一颗新模型，指纹就变了，弹窗会再问一次。 */
export function modelUpdateFingerprint(updates: AvailableModelUpdate[]): string {
  return updates.map((update) => `${update.id}@${update.availableVersion}`).sort().join(',');
}
