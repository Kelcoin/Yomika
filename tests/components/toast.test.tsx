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

describe('toast marks', () => {
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
});
