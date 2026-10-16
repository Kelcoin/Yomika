import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ToastProvider, useToast } from '../../src/components/Toast';

function Emitter() {
  const { showToast } = useToast();
  return <button
    type="button"
    onClick={() => {
      showToast('已保存', 'success');
      showToast('保存失败', 'error');
      showToast('知道了', 'info');
    }}
  >emit</button>;
}

function Repeater() {
  const { showToast } = useToast();
  return <>
    <button type="button" onClick={() => {
      showToast('已连上 DESKTOP-PC', 'success');
      showToast('已连上 DESKTOP-PC', 'success');
    }}>twice</button>
    <button type="button" onClick={() => showToast('已连上 KELCOIN-PC', 'success')}>other</button>
    <button type="button" onClick={() => {
      showToast('已连上 DESKTOP-PC', 'success');
      showToast('已连上 DESKTOP-PC', 'error');
    }}>variants</button>
  </>;
}

describe('toast marks', () => {
  it('can show the same error again immediately after clearing errors', async () => {
    function Retry() {
      const { showToast, clearToasts } = useToast();
      return <>
        <button onClick={() => showToast('请求失败', 'error')}>fail</button>
        <button onClick={() => { clearToasts('error'); showToast('请求失败', 'error'); }}>retry</button>
      </>;
    }
    const user = userEvent.setup();
    render(<ToastProvider><Retry /></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'fail' }));
    await user.click(screen.getByRole('button', { name: 'retry' }));
    expect(screen.getByText('请求失败')).toBeInTheDocument();
  });

  it('draws one semantic mark per type, none of them a cross', async () => {
    const user = userEvent.setup();
    render(<ToastProvider><Emitter /></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'emit' }));

    const marks = [...document.querySelectorAll('.toast-icon svg')];
    expect(marks).toHaveLength(3);
    // 每枚都是「一个圆 + 自己的字形」：圆的直径 9，字形在圆心里。
    for (const mark of marks) {
      expect(mark.querySelectorAll('circle')).toHaveLength(1);
      expect(mark.querySelector('circle')?.getAttribute('r')).toBe('9');
    }
    const shapeOf = (mark: Element) => [...mark.querySelectorAll('path')].map((path) => path.getAttribute('d'));
    const [success, error, info] = marks.map(shapeOf);
    // 成功是勾，错误是感叹号，信息是提示号——三枚字形互不相同。
    expect(success).toEqual(['M8 12.4l2.7 2.7L16 9.6']);
    expect(error).toEqual(['M12 7.6v5.6', 'M12 16.4h.01']);
    expect(info).toEqual(['M12 11.4v5', 'M12 7.6h.01']);
    // 斜线只出现在关闭按钮里：三枚标记合计 5 条路径（勾 1、感叹号 2、提示号 2），
    // 关闭按钮另有 3×2 条。以前错误提示那枚叉圈图标就混在这 5 条里。
    expect(document.querySelectorAll('.toast-icon svg path')).toHaveLength(5);
    expect(document.querySelectorAll('.toast-close')).toHaveLength(3);
    expect(document.querySelectorAll('.toast-close svg path')).toHaveLength(6);
  });

  /** 同一句话叠两张，看起来就是「它报了两次」：第二张折进还在的那一张，把它的计时重新起算。 */
  it('folds a repeated message into the toast that is already up', async () => {
    const user = userEvent.setup();
    render(<ToastProvider><Repeater /></ToastProvider>);

    await user.click(screen.getByRole('button', { name: 'twice' }));
    expect(screen.getAllByText('已连上 DESKTOP-PC')).toHaveLength(1);

    // 不同的话照样各占一张（去重只认「同一句 + 同一种颜色」）。
    await user.click(screen.getByRole('button', { name: 'other' }));
    expect(screen.getAllByText('已连上 KELCOIN-PC')).toHaveLength(1);
    expect(screen.getAllByText('已连上 DESKTOP-PC')).toHaveLength(1);

    // 同色不同文、同文不同色的都不算重复。
    await user.click(screen.getByRole('button', { name: 'variants' }));
    expect(screen.getAllByText('已连上 DESKTOP-PC')).toHaveLength(2);
  });
});
