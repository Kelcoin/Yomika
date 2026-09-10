import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EhWorkspace } from '../../src/components/EhWorkspace';
import type { EhAccount } from '../../src/domain/eh';

describe('EhWorkspace', () => {
  const sampleAccounts: EhAccount[] = [
    { id: 'eh-a', label: 'EH Main', host: 'e-hentai.org', cookieRef: 'ref-a', isActive: true, status: 'verified', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  ];

  it('renders account management without an EH search field', () => {
    render(<EhWorkspace accounts={sampleAccounts} />);
    expect(screen.getByLabelText('E-Hentai 账户')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'E-Hentai 账户' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: '搜索 E-Hentai' })).not.toBeInTheDocument();
  });

  it('hides every login control when an account is configured', () => {
    render(<EhWorkspace accounts={sampleAccounts} onSaveAccount={async () => {}} onPasswordLogin={async () => ''} onBrowserLogin={async () => ''} />);
    expect(screen.queryByRole('tab', { name: '账号登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /添加|收起|展开/ })).not.toBeInTheDocument();
  });

  it('moves the account surface with the pointer and reveals its actions', () => {
    render(<EhWorkspace accounts={sampleAccounts} onReadCookie={async () => 'ipb_member_id=1'} onLogout={async () => {}} />);
    const surface = screen.getByTestId('eh-account-surface-eh-a');
    fireEvent.touchStart(surface, { touches: [{ clientX: 240 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: 140 }] });
    expect(surface).toHaveStyle({ transform: 'translate3d(-100px, 0, 0)' });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 140 }] });
    expect(screen.getByRole('button', { name: '导出EH Main Cookie' })).toBeVisible();
    expect(screen.getByRole('button', { name: '登出EH Main' })).toBeVisible();
  });
});
