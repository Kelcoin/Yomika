import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';

const repository = new NativeLibraryRepository();

/** 把收藏写入镜像到 LANraragi 的 🔖 Favorites 分类。
 *
 * 收藏夹书架读的就是那条分类，只写本地那一份永远显示不出来——所以详情页的心、
 * 右键菜单与多选都把写入镜像过去。返回镜像失败的条数：服务器上没有这条分类时
 * 也算 0（那不是失败，只是这台服务器没开收藏分类，本机那份就是全部）。
 *
 * 取那条分类走 `readFavoritesCategory`：它不解析动态分类，一次两百毫秒；`listCategories`
 * 在快照过期后要把每条动态分类各跑一次不分页的全库搜索（1.5 万档案的库上 23 秒）。 */
export async function mirrorFavorites(
  serverId: string,
  archiveIds: readonly string[],
  next: boolean,
): Promise<number> {
  if (archiveIds.length === 0) return 0;
  const favorites = await repository.readFavoritesCategory(serverId);
  if (!favorites.ok || !favorites.value) return 0;
  const categoryId = favorites.value.id;
  const results = await Promise.all(archiveIds.map((archiveId) => (
    next
      ? repository.addArchiveToCategory(serverId, categoryId, archiveId)
      : repository.removeArchiveFromCategory(serverId, categoryId, archiveId)
  )));
  return results.filter((result) => !result.ok).length;
}
