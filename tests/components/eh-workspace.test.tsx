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

  it('keeps every account action visible without a swipe', () => {
    // 与其它设置逻辑一致：操作以文字按钮列在账户卡片底部，不再依赖滑动呼出。
    render(<EhWorkspace accounts={sampleAccounts} onCheckHealth={async () => {}} onReadCookie={async () => 'ipb_member_id=1'} onLogout={async () => {}} />);
    expect(screen.getByRole('button', { name: '导出 Cookie' })).toBeVisible();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeVisible();
    expect(screen.getByRole('button', { name: '检查登录状态' })).toBeVisible();
  });
});
