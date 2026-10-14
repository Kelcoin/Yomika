import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ReaderScreen } from '../../src/components/ReaderScreen';
import { setImageDecoderForTests } from '../../src/lib/decodeImage';

afterEach(() => setImageDecoderForTests(undefined));

it('turns a DOM image failure into a page retry that reacquires its handle', async () => {
  const loadPage = vi.fn().mockResolvedValueOnce('blob:broken').mockResolvedValue('blob:fresh');
  const releasePage = vi.fn();
  render(<MemoryRouter><ReaderScreen archiveId="retry" title="Retry" pages={['']} layout="single" loadPage={loadPage} releasePage={releasePage} /></MemoryRouter>);
  fireEvent.error(await screen.findByRole('img', { name: '第 1 页' }));
  const retry = await screen.findByRole('button', { name: '重试加载' });
  expect(loadPage).toHaveBeenCalledTimes(1);
  fireEvent.click(retry);
  await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:fresh'));
  expect(releasePage).toHaveBeenCalledWith(0);
  expect(loadPage).toHaveBeenCalledTimes(2);
});

it('keeps the original when a replacement fails to decode', async () => {
  setImageDecoderForTests(() => Promise.reject(new Error('bad rendition')));
  const view = render(<MemoryRouter><ReaderScreen archiveId="decode" title="Decode" pages={['blob:plain']} layout="single" /></MemoryRouter>);
  view.rerender(<MemoryRouter><ReaderScreen archiveId="decode" title="Decode" pages={['blob:plain']} layout="single" derivedPages={new Map([[0, 'blob:bad-derived']])} /></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:plain');
});

it('starts the desktop indicator in the corner before any image measurement', async () => {
  render(<MemoryRouter><ReaderScreen archiveId="placement" title="Placement" pages={['blob:plain']} layout="single" /></MemoryRouter>);
  expect(document.querySelector('.reader-page-indicator')).toHaveAttribute('data-placement', 'corner');
  await act(async () => {});
});

it('does not publish a page request that finishes after a rendition reload', async () => {
  let finish: ((url: string) => void) | undefined;
  const loadPage = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; })).mockResolvedValue('blob:new');
  const view = render(<MemoryRouter><ReaderScreen archiveId="race" title="Race" pages={['']} layout="single" loadPage={loadPage} /></MemoryRouter>);
  view.rerender(<MemoryRouter><ReaderScreen archiveId="race" title="Race" pages={['']} layout="single" loadPage={loadPage} reloadToken={1} /></MemoryRouter>);
  await act(async () => { finish?.('blob:old'); });
  await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:new'));
});

it('does not exhaust the original when the displayed derived predecessor fails while its successor decodes', async () => {
  let finish: (() => void) | undefined;
  setImageDecoderForTests(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<MemoryRouter><ReaderScreen archiveId="predecessor" title="Predecessor" pages={['blob:plain']} layout="single" derivedPages={new Map([[0, 'blob:derived-a']])} /></MemoryRouter>);
  view.rerender(<MemoryRouter><ReaderScreen archiveId="predecessor" title="Predecessor" pages={['blob:plain']} layout="single" derivedPages={new Map([[0, 'blob:derived-b']])} /></MemoryRouter>);
  fireEvent.error(screen.getByRole('img', { name: '第 1 页' }));
  expect(screen.queryByRole('button', { name: '重试加载' })).not.toBeInTheDocument();
  await act(async () => { finish?.(); });
  expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:derived-b');
});

it('offers original retry when a broken derived page cannot recover to the original', async () => {
  setImageDecoderForTests(() => Promise.reject(new Error('original cannot decode')));
  const loadPage = vi.fn().mockResolvedValue('blob:fresh-original');
  const releasePage = vi.fn();
  render(<MemoryRouter><ReaderScreen archiveId="recovery" title="Recovery" pages={['blob:plain']} layout="single" derivedPages={new Map([[0, 'blob:derived']])} loadPage={loadPage} releasePage={releasePage} /></MemoryRouter>);
  fireEvent.error(screen.getByRole('img', { name: '第 1 页' }));
  const retry = await screen.findByRole('button', { name: '重试加载' });
  fireEvent.click(retry);
  await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:fresh-original'));
  expect(releasePage).toHaveBeenCalledWith(0);
});
