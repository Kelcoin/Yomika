import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AboutDetails } from '../../src/components/AboutDetails';

it('opens the bundled full license, including the warranty and copyright notice', () => {
  render(<AboutDetails />);
  fireEvent.click(screen.getByRole('button', { name: /开源协议/ }));
  const text = screen.getByRole('dialog').textContent!;
  expect(text).toContain('Copyright (c) 2026 Yomika contributors');
  expect(text).toContain('Permission is hereby granted');
  expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  expect(text).toContain('SOFTWARE.');
});
it('leaves the build details off the about page', () => {
  render(<AboutDetails />);
  expect(screen.queryByText('构建于')).toBeNull();
  expect(screen.queryByText('Tauri 2 · React 18 · SQLite')).toBeNull();
  expect(screen.queryByRole('button', { name: /构建于/ })).toBeNull();
});
