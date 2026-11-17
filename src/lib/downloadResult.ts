import type { DownloadResult } from '../domain/library';

/** 下载结果的说明文字。暂停和中止不是失败，但都得说清楚文件现在在哪：完成给
 * 路径，暂停指向本地档案页，中止说文件已经删掉。 */
export function downloadResultMessage(result: DownloadResult): string {
  if (result.status === 'completed') return `下载完成：${result.path}`;
  if (result.status === 'existing') return '该档案已有下载任务，可在本地档案页查看';
  if (result.status === 'paused') return '已暂停，可在本地档案页继续';
  if (result.status === 'cancelled') return '已中止下载';
  return '下载失败';
}

/** 失败才用错误色；暂停和中止是用户自己按的，不该报成错误。 */
export function downloadResultTone(result: DownloadResult): 'success' | 'info' | 'error' {
  if (result.status === 'completed') return 'success';
  if (result.status === 'failed') return 'error';
  return 'info';
}
