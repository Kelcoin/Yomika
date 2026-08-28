import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import type { CommandResult } from '../domain/result';
import { createServerIdentity, type ServerIdentity } from '../domain/server';

interface ServerSetupDialogProps {
  onSave: (input: { identity: ServerIdentity; apiKey: string }) => Promise<CommandResult<ServerIdentity>>;
}

export function ServerSetupDialog({ onSave }: ServerSetupDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const identity = await createServerIdentity({
        name: String(form.get('name') ?? ''),
        baseUrl: String(form.get('baseUrl') ?? ''),
      });
      const result = await onSave({ identity, apiKey: String(form.get('apiKey') ?? '') });
      if (result.ok) setOpen(false);
      else setError(result.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '服务器配置无效');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) setError(undefined); }}>
      <Dialog.Trigger asChild><button className="primary-action" type="button">添加服务器</button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div className="dialog-heading">
            <div>
              <Dialog.Title>添加 LANraragi</Dialog.Title>
              <Dialog.Description>连接信息保存在此设备；API Key 仅进入系统安全存储。</Dialog.Description>
            </div>
            <Dialog.Close asChild><button className="icon-button" type="button" aria-label="关闭"><X aria-hidden="true" /></button></Dialog.Close>
          </div>
          <form className="server-form" onSubmit={handleSubmit}>
            <label>名称<input name="name" required autoComplete="off" /></label>
            <label>服务器地址<input name="baseUrl" required type="url" inputMode="url" placeholder="https://library.example.com/…" autoComplete="url" spellCheck={false} /></label>
            <label>API Key<input name="apiKey" type="password" autoComplete="off" spellCheck={false} /></label>
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
