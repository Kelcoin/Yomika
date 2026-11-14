import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StateIcon, type StateIconName } from '../../src/components/StateIcon';
import { DlssnrIcon } from '../../src/components/DlssnrIcon';
import { UpscaleIcon } from '../../src/components/UpscaleIcon';

const names = [
  'home', 'archive', 'history', 'star', 'bookmark', 'drive', 'settings',
  'heart', 'image', 'comments', 'grid', 'play', 'pause', 'sparkles',
  'select', 'list', 'finished', 'chain', 'folder', 'cloudDownload',
  'login', 'globe', 'cookie', 'thumbUp', 'thumbDown',
] as const satisfies readonly StateIconName[];

describe('functional icon states', () => {
  it.each(names)('%s changes geometry only when selected, retaining its icon slot', name => {
    const view = render(<StateIcon name={name} className="icon-slot" style={{ color: 'red' }} />);
    const outline = view.container.querySelector('svg')!;
    const geometry = outline.innerHTML;
    expect(outline).toHaveAttribute('viewBox', '0 0 24 24');
    expect(outline).toHaveAttribute('fill', 'none');
    expect(outline).toHaveClass('app-icon', 'icon-slot');
    expect(outline.querySelector('[fill="currentColor"]')).toBeNull();
    expect(outline).toHaveAttribute('aria-hidden', 'true');
    expect(outline).toHaveAttribute('focusable', 'false');
    view.rerender(<StateIcon name={name} selected className="icon-slot" style={{ color: 'red' }} />);
    const filled = view.container.querySelector('svg')!;
    expect(filled).toHaveClass('app-icon', 'icon-slot');
    expect(filled).toHaveStyle({ color: 'rgb(255, 0, 0)' });
    expect(filled).toHaveAttribute('viewBox', '0 0 24 24');
    expect(filled.innerHTML).not.toEqual(geometry);
    expect(filled.querySelector('[fill="currentColor"][stroke="none"]')).not.toBeNull();
  });

  it.each([UpscaleIcon, DlssnrIcon])('keeps enhancement headings neutral and fills enabled switches', Icon => {
    const view = render(<Icon />);
    expect(view.container.querySelector('[fill="currentColor"]')).toBeNull();
    view.rerender(<Icon enabled />);
    expect(view.container.querySelector('[fill="currentColor"]')).not.toBeNull();
    view.rerender(<Icon enabled={false} />);
    expect(view.container.querySelector('[fill="currentColor"]')).toBeNull();
  });
});
