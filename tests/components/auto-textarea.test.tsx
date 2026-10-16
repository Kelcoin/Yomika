import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AutoTextarea } from '../../src/components/AutoTextarea';

it('grows and shrinks with content, capping height with internal scrolling', () => {
  let content = 120;
  const spy = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => content);
  try {
    const view = render(<AutoTextarea aria-label="Summary" value="one" onChange={() => undefined} />);
    const input = screen.getByRole('textbox');
    expect(input.style.resize).toBe('none');
    expect(input.style.height).toBe('122px');
    content = 900;
    fireEvent.input(input);
    expect(parseFloat(input.style.height)).toBeLessThanOrEqual(480);
    expect(input.style.overflowY).toBe('auto');
    content = 100;
    view.rerender(<AutoTextarea aria-label="Summary" value="short" onChange={() => undefined} />);
    expect(input.style.height).toBe('102px');
    expect(input.style.overflowY).toBe('hidden');
  } finally { spy.mockRestore(); }
});
