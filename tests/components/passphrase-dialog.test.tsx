import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PassphraseDialog } from '../../src/components/PassphraseDialog';

/** 导出模式（两个框）与导入模式（一个框）都从这里开。 */
function renderDialog(mode: 'export' | 'import' = 'export', onConfirm = vi.fn()) {
  render(<PassphraseDialog open mode={mode} onConfirm={onConfirm} onOpenChange={() => undefined} />);
  return { onConfirm };
}

describe('passphrase dialog', () => {
  it('gives every field exactly one reveal button, inside the box', async () => {
    // 用户看到的两个眼睛是「浏览器自带（框里，只在有内容时出现）+ 我们的（框外）」。
    // 现在输入框是 `type="text"` + CSS 遮罩，所以浏览器不再画它自己的那个，剩下的是
    // 我们这一枚——**每个框都有，而且一直在**（空框也有）。
    renderDialog();
    const fields = ['口令', '再输一遍'];
    for (const label of fields) {
      const input = screen.getByLabelText(label, { exact: true });
      expect(input).toHaveAttribute('type', 'text');
      expect(input).toHaveClass('is-masked');
      const box = input.closest('.passphrase-box');
      expect(box).not.toBeNull();
      // 框里那个按钮：整份对话框里每个框各有且仅有一枚。
      expect(within(box as HTMLElement).getAllByRole('button')).toHaveLength(1);
    }
    expect(screen.getAllByRole('button', { name: '显示口令' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /隐藏口令/ })).toBeNull();

    // 空框也看得见这枚按钮（用户报的「输入框内部按钮会消失」就是空框那一种）。
    expect(screen.getAllByRole('button', { name: '显示口令' })[1]).toBeInTheDocument();

    // 打开任意一枚，两个框一起明文（它们是同一个口令）。
    await userEvent.click(screen.getAllByRole('button', { name: '显示口令' })[0]!);
    for (const label of fields) expect(screen.getByLabelText(label, { exact: true })).not.toHaveClass('is-masked');
  });

  it('says nothing about the passphrase while it is still being typed', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    const passphrase = screen.getByLabelText('口令', { exact: true });
    const confirm = screen.getByLabelText('再输一遍', { exact: true });

    await user.type(passphrase, 'short');
    // 还在第一个框里打字：不教训人。
    expect(screen.queryByText('口令至少 8 个字符')).toBeNull();

    // 离开这个框（跳到下一个）才算写完：这时才说。
    await user.click(confirm);
    expect(await screen.findByText('口令至少 8 个字符')).toBeInTheDocument();

    // 按「导出」也不会带着一个不合格的口令走。
    await user.click(screen.getByRole('button', { name: '导出' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps the mismatch quiet until the second field is left or 导出 is pressed', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.type(screen.getByLabelText('口令', { exact: true }), 'a-long-passphrase');
    const confirm = screen.getByLabelText('再输一遍', { exact: true });
    await user.type(confirm, 'a-different-one');
    // 第二个框里刚打完：第一个框早已失焦，但这里仍不开口。
    expect(screen.queryByText('两次输入的口令不一致')).toBeNull();

    // 离开第二个框 → 说。
    fireEvent.blur(confirm);
    expect(await screen.findByText('两次输入的口令不一致')).toBeInTheDocument();

    // 改一致之后按导出：真的交出去。
    await user.clear(confirm);
    await user.type(confirm, 'a-long-passphrase');
    await user.click(screen.getByRole('button', { name: '导出' }));
    expect(onConfirm).toHaveBeenCalledWith('a-long-passphrase');
  });
});
