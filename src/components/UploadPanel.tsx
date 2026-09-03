import { Upload } from 'lucide-react';
import { useState } from 'react';

import { pickArchiveFile } from '../bridge/filePicker';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';

const repository = new NativeLibraryRepository();

/** Archive upload, lifted out of the task list so it can live in the settings
 * tools section next to deduplication (Readoshi keeps upload as a tool too). */
export function UploadPanel() {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  async function upload() {
    setError(undefined);
    setMessage(undefined);
    setUploading(true);
    try {
      const filePath = await pickArchiveFile();
      if (!filePath) return;
      const servers = await repository.listServers();
      if (!servers.ok || !servers.value[0]) {
        setError(servers.ok ? '尚未配置服务器' : servers.error.message);
        return;
      }
      const filename = filePath.split(/[\\/]/).pop() ?? filePath;
      const created = await repository.createTask({ kind: 'download', label: `上传 ${filename}` });
      if (!created.ok) {
        setError(created.error.message);
        return;
      }
      const uploaded = await repository.uploadArchive({ serverId: servers.value[0].id, taskId: created.value.id, filePath });
      if (!uploaded.ok) {
        setError(uploaded.error.message);
        return;
      }
      setMessage(`已上传 ${filename}，可在下载页查看任务进度`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="settings-tool-panel" aria-labelledby="upload-panel-title">
      <div className="section-heading">
        <h3 id="upload-panel-title">上传档案</h3>
        <Upload aria-hidden="true" />
      </div>
      <p className="settings-tool-hint">选择本地压缩包上传到 LANraragi，上传任务会出现在下载页。</p>
      <button className="primary-action" type="button" disabled={uploading} aria-busy={uploading} onClick={() => void upload()}>
        <Upload aria-hidden="true" />{uploading ? '上传中…' : '选择文件并上传'}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="server-list-message" role="status">{message}</p>}
    </section>
  );
}
