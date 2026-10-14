import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Group, Panel } from '../../src/components/AdaptivePanels';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses plain flow panels on compact screens without resize scroll wrappers', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('900px'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  render(<Group orientation="horizontal"><Panel id="list" className="list-content" style={{ height: '100%', overflow: 'hidden' }}><button>档案卡片</button></Panel></Group>);
  const card = screen.getByRole('button');
  const panel = card.parentElement!;
  expect(panel).toHaveClass('list-content');
  expect(panel).toHaveAttribute('data-panel');
  expect(panel.style.overflow).toBe('visible');
  expect(panel.style.height).toBe('auto');
  expect(panel.children).toHaveLength(1);
  expect(panel.parentElement?.style.overflow).toBe('visible');
});

it('retains the resizable desktop panel implementation on wide screens', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList));
  render(<Group orientation="horizontal"><Panel id="list" className="list-content"><span>内容</span></Panel></Group>);
  expect(screen.getByText('内容').parentElement).toHaveClass('list-content');
  expect(screen.getByText('内容').parentElement?.parentElement).toHaveAttribute('data-panel');
});
