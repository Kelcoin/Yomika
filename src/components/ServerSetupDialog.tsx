import * as Dialog from '@radix-ui/react-dialog';
import { Pencil, Server } from 'lucide-react';
import { X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import type { CommandResult } from '../domain/result';
import { createServerIdentity, normalizeServerUrl, type ServerIdentity } from '../domain/server';
import type { ServerRecord } from '../domain/library';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { SettingsRowBody } from './SettingsRow';

const repository = new NativeLibraryRepository();

/** 「当前服务器」的标记：一盏亮着的灯。
 *
 * 行首已经有一枚服务器图标，名字旁再画一台机箱是重复——标记只需要说状态：
 * 这台在用。所以只剩实心圆点加一圈光晕，落在 24px 网格上、用 currentColor，
 * 颜色由调用处决定。 */
function ServerActiveMark() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="9.5" fill="currentColor" fillOpacity="0.2" />
    <circle cx="12" cy="12" r="4.75" fill="currentColor" />
  </svg>;
}

interface ServerSetupDialogProps {
  onSave: (input: { identity: ServerIdentity; apiKey: string }) => Promise<CommandResult<ServerIdentity>>;
  server?: Pick<ServerRecord, 'name' | 'baseUrl' | 'scopeId' | 'enabled'>;
  /** 'row' renders the trigger as a settings row (icon, name, address, state) so
   * the whole strip opens the dialog; 'action' keeps the old compact trigger. */
  variant?: 'action' | 'row';
}

export function ServerSetupDialog({ onSave, server, variant = 'action' }: ServerSetupDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setError(undefined);
      setName(server?.name ?? '');
      setBaseUrl(server?.baseUrl ?? '');
      setApiKey('');
    }
  }

  // 编辑已配置的服务器时把安全存储里的 Key 读回来：用户应当能看到自己之前
  // 配置的值，而不是面对一个必须凭记忆重填的空框。
  useEffect(() => {
    if (!open || !server) return undefined;
    let active = true;
    void repository.readServerApiKey(server.scopeId).then((result) => {
      if (!active) return;
      if (result.ok && result.value) setApiKey(result.value);
    });
    return () => { active = false; };
  }, [open, server]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
      setPending(true);
    try {
      // Editing keeps the server's original identity: the scope id keys every
      // archive, progress and history row for this server, so re-deriving it
      // from a renamed or re-addressed profile would orphan all of that and
      // pile a duplicate row into the server list.
      const identity: ServerIdentity = server
        ? { name, baseUrl: normalizeServerUrl(baseUrl), scopeId: server.scopeId }
        : await createServerIdentity({ name, baseUrl });
      const result = await onSave({ identity, apiKey });
      if (result.ok) setOpen(false);
      else setError(result.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '服务器配置无效');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      {/* 行的三格交给共享的 SettingsRowBody：这是唯一一处不能用 SettingsRow
          的地方——asChild 会把对话框属性交给触发器的子元素，所以这一行的元素
          必须是触发器自己的按钮，行的内容则不必自己再画一遍。 */}
      {variant === 'row' ? (
        <Dialog.Trigger asChild><button
          className="settings-row settings-row-button"
          type="button"
          aria-label={server ? `编辑 ${server.name}` : '添加服务器'}
        >
          <SettingsRowBody
            icon={<Server aria-hidden="true" />}
            label={(
              <>
                {server ? server.name : '添加服务器'}
                {/* 当前启用的服务器：书架、首页与档案库都读它。标记跟在名字
                    后面，一眼可辨又不占行尾的空间；语义交给图标 + 名称，
                    悬停有说明。 */}
                {server?.enabled && <span className="server-current-badge" role="img" aria-label="当前服务器" title="当前启用的服务器"><ServerActiveMark /></span>}
              </>
            )}
            hint={server ? server.baseUrl : '连接一台 LANraragi 服务器'}
            value={server ? '已配置' : undefined}
            trailing="nav"
          />
        </button></Dialog.Trigger>
      ) : (
        <Dialog.Trigger asChild><button
          className={server ? 'icon-action server-edit-action' : 'primary-action'}
          type="button"
          /* Icon only, like every other row action; the name stays on the label for
             screen readers and tooltips. */
          aria-label={server ? `编辑 ${server.name}` : '添加服务器'}
          title={server ? '编辑服务器' : undefined}
        >{server ? <Pencil aria-hidden="true" /> : '添加服务器'}</button></Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{server ? '更新 LANraragi' : '添加 LANraragi'}</Dialog.Title>
              <Dialog.Description>连接信息保存在此设备；API Key 存于系统安全存储，已自动读入，可直接查看或替换。</Dialog.Description>
            </div>
            <Dialog.Close asChild><button className="icon-button" type="button" aria-label="关闭"><X aria-hidden="true" /></button></Dialog.Close>
          </div>
          <form className="server-form" onSubmit={handleSubmit}>
            <label>名称（可选）<input aria-label="名称" name="name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" placeholder="留空则使用服务器名称" /></label>
            <label>服务器地址<input name="baseUrl" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required type="url" inputMode="url" placeholder="https://library.example.com/…" autoComplete="url" spellCheck={false} /></label>
            <label>API Key<input name="apiKey" value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="off" spellCheck={false} required /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <Dialog.Close asChild><button className="secondary-action" type="button">取消</button></Dialog.Close>
              <button className="primary-action" type="submit" disabled={pending} aria-busy={pending}>{pending ? '保存中…' : '保存服务器'}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
