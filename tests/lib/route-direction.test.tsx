import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useRouteDirection } from '../../src/lib/useRouteDirection';

function Probe() {
  const direction = useRouteDirection();
  const navigate = useNavigate();
  return <><output>{direction}</output>
    <button onClick={() => navigate('/settings')}>Open</button>
    <button onClick={() => navigate(-1)}>Back</button>
    <button onClick={() => navigate(1)}>Forward</button>
    <button onClick={() => navigate('/settings?section=advanced', { replace: true })}>Replace</button>
  </>;
}

it('reverses Back while preserving Forward and replacement history identities', () => {
  render(<MemoryRouter initialEntries={['/']}><Probe /></MemoryRouter>);
  fireEvent.click(screen.getByText('Open'));
  expect(screen.getByRole('status')).toHaveTextContent('1');
  fireEvent.click(screen.getByText('Back'));
  expect(screen.getByRole('status')).toHaveTextContent('-1');
  fireEvent.click(screen.getByText('Forward'));
  expect(screen.getByRole('status')).toHaveTextContent('1');
  fireEvent.click(screen.getByText('Replace'));
  fireEvent.click(screen.getByText('Back'));
  expect(screen.getByRole('status')).toHaveTextContent('-1');
  fireEvent.click(screen.getByText('Forward'));
  expect(screen.getByRole('status')).toHaveTextContent('1');
});
