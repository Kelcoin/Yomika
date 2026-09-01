import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import type { CommandResult } from '../domain/result';
import { createServerIdentity, type ServerIdentity } from '../domain/server';
import type { ServerRecord } from '../domain/library';

interface ServerSetupDialogProps {
  onSave: (input: { identity: ServerIdentity; apiKey: string }) => Promise<CommandResult<ServerIdentity>>;
  server?: Pick<ServerRecord, 'name' | 'baseUrl'>;
}

export function ServerSetupDialog({ onSave, server }: ServerSetupDialogProps) {
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
      setPending(true);
    try {
      const identity = await createServerIdentity({
        name,
        baseUrl,
      });
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
      <Dialog.Trigger asChild><button className={server ? 'secondary-action server-edit-action' : 'primary-action'} type="button">{server ? `编辑 ${server.name}` : '添加服务器'}</button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{server ? '更新 LANraragi' : '添加 LANraragi'}</Dialog.Title>
              <Dialog.Description>连接信息保存在此设备；API Key 仅进入系统安全存储。更新时请重新输入 API Key。</Dialog.Description>
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
