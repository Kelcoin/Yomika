import { CheckCircle, RefreshCw, ArrowRightLeft } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { EhAccount } from '../domain/eh';
import type { SaveEhAccountInput } from '../domain/eh';
import { SelectField } from './SelectField';

interface EhAccountPanelProps {
  accounts: EhAccount[];
  onSwitch?: ((accountId: string) => void) | undefined;
  onCheckHealth?: ((accountId: string) => void) | undefined;
  loading?: boolean | undefined;
  onSave?: ((input: SaveEhAccountInput) => Promise<void>) | undefined;
  saving?: boolean | undefined;
}

function statusLabel(status: EhAccount['status']): string {
  if (status === 'verified') return '已验证';
  if (status === 'error') return '错误';
  return '未验证';
}

export function EhAccountPanel({ accounts, onSwitch, onCheckHealth, loading, onSave, saving }: EhAccountPanelProps) {
  const [host, setHost] = useState('e-hentai.org');
  const [formError, setFormError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onSave) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const usernameHint = String(data.get('ehUsernameHint') ?? '').trim();
    setFormError(undefined);
    try {
      await onSave({
        id: String(data.get('ehAccountId') ?? '').trim(),
        label: String(data.get('ehAccountLabel') ?? '').trim(),
        host: String(data.get('ehAccountHost') ?? 'e-hentai.org') as SaveEhAccountInput['host'],
        ...(usernameHint ? { usernameHint } : {}),
        cookie: String(data.get('ehCookie') ?? ''),
      });
      form.reset();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '账户保存失败');
    }
  }
  if (loading) {
    return (
      <section className="eh-account-panel" aria-label="E-Hentai 账户">
        <p role="status">正在读取账户…</p>
      </section>
    );
  }

  return (
    <section className="eh-account-panel" aria-label="E-Hentai 账户">
      {accounts.length === 0 && <p>尚未添加 E-Hentai 账户</p>}
      {onSave && (
        <form className="eh-account-form" onSubmit={submit}>
          <label>账户 ID<input name="ehAccountId" required pattern="[A-Za-z0-9_-]+" autoComplete="off" /></label>
          <label>名称<input name="ehAccountLabel" required autoComplete="off" /></label>
          <label>站点<SelectField name="ehAccountHost" value={host} options={[{ value: 'e-hentai.org', label: 'e-hentai.org' }, { value: 'exhentai.org', label: 'exhentai.org' }]} onChange={setHost} /></label>
          <label>用户名提示<input name="ehUsernameHint" autoComplete="username" spellCheck={false} /></label>
          <label>Cookie<input name="ehCookie" required type="password" autoComplete="current-password" spellCheck={false} /></label>
          <button className="secondary-action" type="submit" disabled={saving} aria-busy={saving}>{saving ? '保存中…' : '保存 E-Hentai 账户'}</button>
          {formError && <p className="form-error" role="alert">{formError}</p>}
        </form>
      )}
      {accounts.length === 0 ? null : (
      <ul>
        {accounts.map((account) => (
          <li key={account.id} className={account.isActive ? 'active' : ''}>
            <div>
              <strong>{account.label}</strong>
              <span>{account.host}</span>
              <small>{statusLabel(account.status)}</small>
            </div>
            <div className="account-actions">
              {onCheckHealth && (
                <button type="button" className="icon-button" aria-label={`检查${account.label}`} title="检查登录状态" onClick={() => onCheckHealth(account.id)}>
                  <RefreshCw aria-hidden="true" />
                </button>
              )}
              {onSwitch && !account.isActive && (
                <button type="button" className="icon-button" aria-label={`切换到${account.label}`} title="切换账户" onClick={() => onSwitch(account.id)}>
                  <ArrowRightLeft aria-hidden="true" />
                </button>
              )}
              {account.isActive && <CheckCircle aria-label="当前活跃" />}
            </div>
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}
