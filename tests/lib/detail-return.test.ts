import { fireEvent } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { detailReturnTarget, installDetailOrigins, prepareDetailReturn } from '../../src/lib/detailReturn';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

it('uses fresh source geometry and ignores modified or external clicks', () => {
  dispose = installDetailOrigins();
  const anchor = document.createElement('a');
  anchor.addEventListener('click', (event) => event.preventDefault());
  anchor.href = '/library/book?server=one';
  document.body.append(anchor);
  let rect = new DOMRect(20, 40, 100, 150);
  anchor.getBoundingClientRect = () => rect;
  fireEvent.click(anchor, { ctrlKey: true });
  expect(detailReturnTarget({ pathname: '/library/book', search: '?server=one' })).toBeUndefined();
  anchor.href = 'https://example.com/library/book?server=one';
  fireEvent.click(anchor);
  expect(detailReturnTarget({ pathname: '/library/book', search: '?server=one' })).toBeUndefined();
  anchor.href = '/library/book?server=one';
  fireEvent.click(anchor);
  rect = new DOMRect(30, 50, 110, 160);
  expect(detailReturnTarget({ pathname: '/library/book', search: '?server=one' })).toBe(rect);
  expect(detailReturnTarget({ pathname: '/library/book', search: '?server=two' })).toBeUndefined();
  anchor.hidden = true;
  expect(detailReturnTarget({ pathname: '/library/book', search: '?server=one' })).toBeUndefined();
  anchor.hidden = false;
  anchor.remove();
  expect(detailReturnTarget({ pathname: '/library/book', search: '?server=one' })).toBeUndefined();
});

it('freezes only the visible slice of a tall live detail and restores its exact style', () => {
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  const panel = document.createElement('section');
  const detail = document.createElement('div'); detail.style.color = 'red'; detail.textContent = 'Live contents';
  workspace.append(panel); panel.append(detail); document.body.append(workspace);
  workspace.getBoundingClientRect = () => new DOMRect(0, 50, 500, 700);
  detail.getBoundingClientRect = () => new DOMRect(20, -1000, 460, 4000);
  const before = detail.getAttribute('style');
  const restore = prepareDetailReturn(panel, detail);
  expect(detail.style.clipPath).toBe('inset(1050px 0 2250px 0)');
  expect(detail.style.position).toBe('fixed');
  expect(detail.textContent).toBe('Live contents');
  expect(panel.hasAttribute('inert')).toBe(true);
  restore();
  expect(detail.getAttribute('style')).toBe(before);
  expect(panel.hasAttribute('inert')).toBe(false);
  expect(panel.hasAttribute('data-detail-return')).toBe(false);
});

it('includes the full viewport canvas around a short shortcut page without moving its content', () => {
  const workspace = document.createElement('main'); workspace.className = 'workspace';
  const page = document.createElement('section'); workspace.append(page); document.body.append(workspace);
  workspace.getBoundingClientRect = () => new DOMRect(0, 0, 576, 850);
  page.getBoundingClientRect = () => new DOMRect(16, 32, 544, 600);
  const restore = prepareDetailReturn(page, page, true);
  expect(page.style.left).toBe('0px'); expect(page.style.top).toBe('0px');
  expect(page.style.width).toBe('576px'); expect(page.style.height).toBe('850px');
  expect(page.style.paddingLeft).toBe('16px'); expect(page.style.paddingRight).toBe('16px');
  expect(page.style.paddingTop).toBe('32px'); expect(page.hasAttribute('data-page-return')).toBe(true);
  restore();
  expect(page.hasAttribute('style')).toBe(false);
  expect(page.hasAttribute('data-page-return')).toBe(false);
});
