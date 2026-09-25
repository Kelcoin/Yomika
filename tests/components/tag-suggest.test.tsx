import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TagSuggest } from '../../src/components/TagSuggest';
import { installTagTranslations } from '../../src/lib/tags';

/** 候选列表的真实来源是装好的译文库（不 mock：setup 会预加载用到它的组件）。 */
function Harness({ exact, onSelect }: { exact?: boolean; onSelect: (tag: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <input ref={ref} defaultValue="gla" aria-label="标签输入" />
      <TagSuggest inputValue="gla" anchorRef={ref} onSelect={onSelect} {...(exact === undefined ? {} : { exact })} />
    </div>
  );
}

describe('tag suggestions', () => {
  afterEach(() => { installTagTranslations({}); });

  it('adds the exact-query suffix by default, for the library search', async () => {
    // 库检索里 `female:glasses$` 才是「正好是这条」。
    installTagTranslations({ female: { glasses: '眼镜' } });
    const onSelect = vi.fn();
    render(<MemoryRouter><Harness onSelect={onSelect} /></MemoryRouter>);

    const option = await screen.findByRole('option');
    expect(option).toHaveTextContent('female:glasses$');
    fireEvent.mouseDown(option);
    expect(onSelect).toHaveBeenCalledWith('female:glasses$');
  });

  it('adds the bare tag when the caller edits tags rather than queries', async () => {
    // 元数据编辑要的是标签本身：带上 `$` 等于存了一条别人认不出来的标签。
    installTagTranslations({ female: { glasses: '眼镜' } });
    const onSelect = vi.fn();
    render(<MemoryRouter><Harness exact={false} onSelect={onSelect} /></MemoryRouter>);

    const option = await screen.findByRole('option');
    expect(option).toHaveTextContent('female:glasses');
    expect(option).not.toHaveTextContent('female:glasses$');
    fireEvent.mouseDown(option);
    expect(onSelect).toHaveBeenCalledWith('female:glasses');
  });
});
