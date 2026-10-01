import * as Dialog from '@radix-ui/react-dialog';
import { Pencil, Save, Server, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { CommandResult } from '../domain/result';
import { createServerIdentity, normalizeServerUrl, type ServerIdentity } from '../domain/server';
import type { ServerRecord } from '../domain/library';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingsRowBody } from './SettingsRow';
import { useToast } from './Toast';

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
  /** 删除这台服务器的配置。只有编辑已存在的服务器时才会用到；父层负责 toast，
   * 返回 true 表示删掉了（对话框收起），false 表示失败（父层已报错，编辑器留着）。 */
  onDelete?: (() => Promise<boolean>) | undefined;
  /** 'row' renders the trigger as a settings row (icon, name, address, state) so
   * the whole strip opens the dialog; 'action' keeps the old compact trigger. */
  variant?: 'action' | 'row';
}

export function ServerSetupDialog({ onSave, server, onDelete, variant = 'action' }: ServerSetupDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  // 打开编辑时 Radix 会聚焦第一个输入框并全选内容，等于替用户选中了整个名称：
  // 随手敲一个字就把名字换掉了。用 ref 在自动聚焦时把光标放到末尾。
  const nameRef = useRef<HTMLInputElement>(null);
  // 保存失败（地址不通、凭据库写不进去、API Key 太长……）由 toast 说，不再在表单
  // 里留一条红字：那条红字会一直挂到对话框关掉为止，用户改完地址重试时它还在说上
  // 一次的事。toast 的层级（--z-toast 70）本来就高于对话框（--z-modal 51）。
  const { showToast } = useToast();

  // 返回手势先关这一层（见 overlayBackGuard）。
  useOverlayBackGuard(open, () => handleOpenChange(false));

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setName(server?.name ?? '');
      setBaseUrl(server?.baseUrl ?? '');
      setApiKey('');
      setConfirmingDelete(false);
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
      else showToast(result.error.message, 'error');
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '服务器配置无效', 'error');
    } finally {
      setPending(false);
    }
  }

  /** 确认框点了删除：结果由父层说（成功/失败都 toast），这里只决定编辑器留不留。 */
  async function handleDelete() {
    if (!onDelete) return;
    const deleted = await onDelete();
    if (deleted) setOpen(false);
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
        <Dialog.Content
          className="dialog-content"
          onOpenAutoFocus={(event) => {
            // Radix 的自动聚焦会选中第一个文本框的全部内容；编辑服务器时那正是
            // 名称，光标应该落在末尾，免得一次击键抹掉整个名字。
            event.preventDefault();
            const input = nameRef.current;
            if (!input) return;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }}
        >
          {/* 标题直接落在对话框里：这一层原本存在的理由是给右上角那个 ✕ 让位，
              而 ✕ 已经去掉了——关闭走点空白处、Esc 与返回手势。顶部也不再挂说明
              小字：连接信息存哪里不影响用户做决定，地址框自己会说话。 */}
          <Dialog.Title className="dialog-title"><Server aria-hidden="true" />{server ? '更新 LANraragi' : '添加 LANraragi'}</Dialog.Title>
          <form className="server-form" onSubmit={handleSubmit}>
            <label>名称（可选）<input ref={nameRef} aria-label="名称" name="name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" placeholder="留空则使用服务器名称" /></label>
            <label>服务器地址<input name="baseUrl" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required type="url" inputMode="url" placeholder="https://library.example.com/…" autoComplete="url" spellCheck={false} /></label>
            <label>API Key<input name="apiKey" value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="off" spellCheck={false} required /></label>
            {/* 动作行等宽平分：删除配置（仅编辑态）与保存服务器各占一列。
                没有「取消」——对话框本来就能点空白处或按 Esc 关掉，多一颗按钮
                只会让「保存服务器」那一格变小、也让退出与保存看起来一样重。 */}
            <div className="dialog-actions is-balanced">
              {server && onDelete && (
                <button className="secondary-action is-danger" type="button" onClick={() => setConfirmingDelete(true)}><Trash2 aria-hidden="true" />删除配置</button>
              )}
              <button className="primary-action" type="submit" disabled={pending} aria-busy={pending}><Save aria-hidden="true" />{pending ? '保存中…' : '保存服务器'}</button>
            </div>
          </form>
          {confirmingDelete && (
            <ConfirmDialog
              title={`删除「${server?.name ?? ''}」的配置？`}
              // 档案馆藏、阅读进度与阅读记录都按 scope id 存在本机，删配置不动它们；
              // 之后用同一地址重新添加会算出同一个 scope id，也就把那些数据接了回来。
              description="档案馆藏、阅读进度与阅读记录都留在本机。删除后重新添加同一地址即可接回它们；只有这份连接信息与 API Key 会被移除。"
              confirmLabel="删除"
              danger
              onClose={() => setConfirmingDelete(false)}
              onConfirm={handleDelete}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
