import { fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { usePageActive } from '../../src/app/RetainedPage';
import { animateRouteEntry, RetainedPage } from '../../src/app/RetainedPage';

const counts = vi.hoisted(() => ({ more: 0, upload: 0 }));
vi.mock('../../src/components/MorePagesRoute', () => ({ MorePagesRoute: () => {
  counts.more++;
  return <div data-testid="more-probe">{useLocation().search}:{String(usePageActive())}</div>;
} }));
vi.mock('../../src/components/UploadPanel', () => ({ UploadPanel: () => {
  counts.upload++;
  return <div>upload probe</div>;
} }));
vi.mock('../../src/components/DeduplicationWorkspace', () => ({ DeduplicationWorkspace: () => <div>dedup probe</div> }));
import { WorkspaceRoutes, lazyPages } from '../../src/app/routes';

describe('retained navigation render budget', () => {
  it('uses an opacity-only route transition and respects reduced motion', () => {
    const panel = document.createElement('section');
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }) as unknown as Animation);
    Object.defineProperty(panel, 'animate', { configurable: true, value: animate });
    const originalMatchMedia = window.matchMedia;
    let reducedMotion = false;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: reducedMotion }) });
    const animation = animateRouteEntry(panel);
    expect(animate).toHaveBeenCalledWith([{ opacity: 0.9 }, { opacity: 1 }], expect.objectContaining({ duration: 180 }));
    animation?.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    reducedMotion = true;
    expect(animateRouteEntry(panel)).toBeUndefined();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });
  it('keeps editor Back usable while its code is still loading', () => {
    const loader = vi.spyOn(lazyPages, 'metadataEdit').mockImplementation(() => new Promise<never>(() => {}));
    try {
      render(<MemoryRouter initialEntries={[{ pathname: '/library/a/edit', state: { returnTo: '/more' } }]}>
        <WorkspaceRoutes />
      </MemoryRouter>);
      const back = screen.getByRole('button', { name: '返回上一页' });
      expect(back).toBeEnabled();
      fireEvent.click(back);
      expect(screen.getByTestId('more-probe')).toBeVisible();
    } finally { loader.mockRestore(); }
  });
  it('keeps background route elements stable while updating activation and saved location', () => {
    render(<MemoryRouter initialEntries={['/more?test=old']}>
      <Link to="/more?test=new">more</Link>
      <Link to="/tools/upload">upload</Link>
      <Link to="/tools/dedup">dedup</Link>
      <WorkspaceRoutes />
    </MemoryRouter>);
    fireEvent.click(screen.getByText('upload'));
    expect(screen.getByTestId('more-probe')).toHaveTextContent('?test=old:false');
    const hiddenMoreCount = counts.more;
    const uploadCount = counts.upload;
    fireEvent.click(screen.getByText('dedup'));
    expect(counts.more).toBe(hiddenMoreCount);
    // A route that doesn't consume activation does not rerender merely to hide.
    expect(counts.upload).toBe(uploadCount);
    fireEvent.click(screen.getByText('more'));
    expect(screen.getByTestId('more-probe')).toHaveTextContent('?test=new:true');
    expect(screen.getByText('upload probe')).toBeInTheDocument();
    expect(counts.upload).toBe(uploadCount);
  });
});
