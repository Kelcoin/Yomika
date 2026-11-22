import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { DetailPageThumbnail } from '../../src/components/DetailPageThumbnail';

const preview = () => <img src="data:image/png;base64,AA==" alt="" decoding="async" />;

it('keeps the frame when the preview URL itself fails to decode', () => {
  // 地址拿到了、图却画不出来（截断的响应、解码失败）。原来的兜底只管到「地址还没到」：
  // 地址一到就撤骨架，于是浏览器那个破图标直接露在格子里。帧和页码要留住。
  const { container } = render(<DetailPageThumbnail page={7} loading={false}>{preview()}</DetailPageThumbnail>);
  const image = container.querySelector('img')!;
  expect(image).toBeInTheDocument();

  fireEvent.error(image);

  const media = container.querySelector('.archive-page-thumbnail-media')!;
  expect(media).toHaveClass('is-broken');
  expect(media.querySelector('img')).toBeNull();
  expect(screen.getByText('7')).toBeInTheDocument();
});

it('brings the image back when a fresh preview arrives for the same tile', () => {
  const { container, rerender } = render(<DetailPageThumbnail page={7} loading={false}>{preview()}</DetailPageThumbnail>);
  const media = () => container.querySelector('.archive-page-thumbnail-media')!;
  fireEvent.error(container.querySelector('img')!);
  expect(media()).toHaveClass('is-broken');
  // 重新进入加载态 = 换了一次预览：失败标记不能跟着格子一辈子。
  rerender(<DetailPageThumbnail page={7} loading>{preview()}</DetailPageThumbnail>);
  rerender(<DetailPageThumbnail page={7} loading={false}>{preview()}</DetailPageThumbnail>);
  expect(media()).not.toHaveClass('is-broken');
  expect(container.querySelector('img')).not.toBeNull();
});
