import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EhWorkspace } from '../../src/components/EhWorkspace';
import type { EhAccount } from '../../src/domain/eh';
import type { EhSearchResult } from '../../src/services/ehClient';

describe('EhWorkspace', () => {
  const sampleAccounts: EhAccount[] = [
    { id: 'eh-a', label: 'EH Main', host: 'e-hentai.org', cookieRef: 'ref-a', isActive: true, status: 'verified', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  ];

  const sampleResults: EhSearchResult[] = [
    { galleryKey: '12345', url: '/g/12345/abc/', title: 'Test Gallery', category: 'Doujinshi', uploader: 'author', pageCount: 10, tags: ['tag1'] },
  ];

  it('renders account panel and search input', () => {
    render(<EhWorkspace accounts={sampleAccounts} />);
    expect(screen.getByLabelText('E-Hentai 账户')).toBeDefined();
    expect(screen.getByRole('searchbox', { name: '搜索 E-Hentai' })).toBeDefined();
  });

  it('calls onSearch when search form submitted', async () => {
    const onSearch = vi.fn();
    const user = userEvent.setup();
    render(<EhWorkspace accounts={sampleAccounts} onSearch={onSearch} />);
    const input = screen.getByRole('searchbox', { name: '搜索 E-Hentai' });
    await user.type(input, 'test query');
    await user.keyboard('{Enter}');
    expect(onSearch).toHaveBeenCalledWith('test query');
  });

  it('displays search results when provided', () => {
    render(<EhWorkspace accounts={sampleAccounts} results={sampleResults} />);
    expect(screen.getByText('Test Gallery')).toBeDefined();
    expect(screen.getByText('Doujinshi')).toHaveClass('metadata-chip');
    expect(screen.getByText('author')).toBeDefined();
    expect(screen.getByText('10 pages')).toHaveClass('metadata-chip');
  });

  it('shows empty state when no results', () => {
    render(<EhWorkspace accounts={sampleAccounts} results={[]} searched />);
    expect(screen.getByText('未找到匹配的画廊')).toBeDefined();
  });

  it('shows loading state during search', () => {
    render(<EhWorkspace accounts={sampleAccounts} searching />);
    expect(screen.getByText('正在搜索…')).toBeDefined();
  });

  it('displays search error when provided', () => {
    render(<EhWorkspace accounts={sampleAccounts} searchError="Rate limit reached" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Rate limit reached');
  });

  it('blocks search and explains the missing active account', () => {
    render(<EhWorkspace accounts={[]} onSearch={vi.fn()} />);

    expect(screen.getByRole('searchbox', { name: '搜索 E-Hentai' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('请先添加并激活一个 E-Hentai 账户');
  });
});
