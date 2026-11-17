import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ArchiveOverviewPanel } from '../../src/components/ArchiveOverviewPanel';

it('fits the overview title within bounded sizes and groups page/size facts together', () => {
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function(this: HTMLElement) {
    return this.style.fontSize === '18px' || this.style.fontSize === '16px' ? 180 : 300;
  });
  try {
    const view = render(<ArchiveOverviewPanel title="很长的档案标题" pageCount={245} sizeBytes={153300000} thumbnailAt={() => undefined} onClose={() => {}} />);
    expect(screen.getByText('很长的档案标题')).toHaveStyle({ fontSize: '18px' });
    const stats = screen.getByLabelText('档案信息');
    expect(stats.querySelectorAll('[data-fact]')).toHaveLength(2);
    expect(stats.parentElement).toHaveClass('reader-overview-identity');
    view.rerender(<ArchiveOverviewPanel title="新标题" pageCount={245} thumbnailAt={() => undefined} onClose={() => {}} />);
    expect(screen.getByText('新标题')).toHaveStyle({ fontSize: '18px' });
    scroll.mockReturnValue(300);
    view.rerender(<ArchiveOverviewPanel title="超长标题" pageCount={245} thumbnailAt={() => undefined} onClose={() => {}} />);
    expect(screen.getByText('超长标题')).toHaveStyle({ fontSize: '16px' });
    scroll.mockReturnValue(100);
    view.rerender(<ArchiveOverviewPanel title="短标题" pageCount={245} thumbnailAt={() => undefined} onClose={() => {}} />);
    expect(screen.getByText('短标题').style.fontSize).toBe('var(--text-heading)');
  } finally { width.mockRestore(); scroll.mockRestore(); }
});
