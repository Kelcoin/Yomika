import { CheckCircle, RefreshCw, ArrowRightLeft } from 'lucide-react';
import type { EhAccount } from '../domain/eh';

interface EhAccountPanelProps {
  accounts: EhAccount[];
  onSwitch?: ((accountId: string) => void) | undefined;
  onCheckHealth?: ((accountId: string) => void) | undefined;
  loading?: boolean | undefined;
}

function statusLabel(status: EhAccount['status']): string {
  if (status === 'verified') return '已验证';
  if (status === 'error') return '错误';
  return '未验证';
}

export function EhAccountPanel({ accounts, onSwitch, onCheckHealth, loading }: EhAccountPanelProps) {
  if (loading) {
    return (
      <section className="eh-account-panel" aria-label="E-Hentai 账户">
        <p role="status">正在读取账户...</p>
      </section>
    );
  }

  if (accounts.length === 0) {
    return (
      <section className="eh-account-panel" aria-label="E-Hentai 账户">
        <p>尚未添加 E-Hentai 账户</p>
      </section>
    );
  }

  return (
    <section className="eh-account-panel" aria-label="E-Hentai 账户">
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
    </section>
  );
}
