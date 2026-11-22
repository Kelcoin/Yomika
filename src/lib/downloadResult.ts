import type { DownloadResult } from '../domain/library';

/** Use the archive title, or just the filename when a task has no title. */
export function downloadResultMessage(result: DownloadResult, title?: string): string {
  if (result.status === 'completed') {
    const name = title?.trim() || result.path.split(/[\\/]/).pop();
    return name ? `${name} 下载完成` : '下载完成';
  }
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
