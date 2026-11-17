import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { AppShell } from '../../src/components/AppShell';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
vi.mock('../../src/app/preferences', () => ({ usePreferences: () => ({ preferences: DEFAULT_PREFERENCES }) }));
vi.mock('../../src/components/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('../../src/components/TitleBar', () => ({ TitleBar: () => null }));
describe('navigation hover', () => {
  it('clears mouse navigation hover on touch, pointer cancel and navigation', async () => {
    render(<MemoryRouter><AppShell><div /></AppShell></MemoryRouter>);
    const nav = screen.getByRole('navigation', { name: '主导航' });
    const library = within(nav).getByRole('link', { name: '档案库' });
    const pointer = (type: string, pointerType: string) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'pointerType', { value: pointerType });
      fireEvent(library, event);
    };
    pointer('pointerover', 'mouse');
    expect(library).toHaveClass('is-pointer-hovered');
    pointer('pointerdown', 'touch');
    expect(library).not.toHaveClass('is-pointer-hovered');
    pointer('pointerover', 'mouse');
    pointer('pointercancel', 'mouse');
    expect(library).not.toHaveClass('is-pointer-hovered');
    pointer('pointerover', 'touch');
    expect(library).not.toHaveClass('is-pointer-hovered');
    pointer('pointerover', 'mouse');
    const touchOutside = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(touchOutside, 'pointerType', { value: 'touch' });
    fireEvent(document, touchOutside);
    expect(library).not.toHaveClass('is-pointer-hovered');
    pointer('pointerover', 'mouse');
    fireEvent(window, new Event('blur'));
    expect(library).not.toHaveClass('is-pointer-hovered');
    pointer('pointerover', 'mouse');
    pointer('pointerout', 'mouse');
    expect(library).not.toHaveClass('is-pointer-hovered');
    pointer('pointerover', 'mouse');
    fireEvent.click(library);
    await waitFor(() => expect(library).not.toHaveClass('is-pointer-hovered'));
  });

});
