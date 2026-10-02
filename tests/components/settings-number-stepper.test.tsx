import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { SettingsNumber } from '../../src/components/SettingsValueControls';

/** 步进按钮的算术单测。
 *
 * 用户看到的是 `1.1500000000000001` 这一串——它出现在**输入框里**，不是四舍五入后的
 * 显示值上，所以要盯着 input 的 value，而不是只盯写回偏好的数字。 */
function Harness({ initial, step, max = 2 }: { initial: number; step: number; max?: number }) {
  const [value, setValue] = useState(initial);
  return <SettingsNumber label="局部色调" value={value} min={0} max={max} step={step} onChange={setValue} />;
}

function input() {
  return screen.getByRole('spinbutton', { name: '局部色调' });
}

async function openStepper(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '局部色调' }));
  await screen.findByRole('dialog', { name: '局部色调' });
}

describe('numeric stepper arithmetic', () => {
  it('adds the step without leaving binary float residue behind', async () => {
    const user = userEvent.setup();
    render(<Harness initial={1.1} step={0.1} />);
    await openStepper(user);

    // 1.1 + 0.1 在 IEEE754 下是 1.2000000000000002。
    await user.click(screen.getByRole('button', { name: '增大局部色调' }));
    expect(input()).toHaveValue(1.2);
    // 残渣还会往后累加：1.2000000000000002 + 0.1 是 1.3000000000000003。
    await user.click(screen.getByRole('button', { name: '增大局部色调' }));
    expect(input()).toHaveValue(1.3);
  });

  it('subtracts the step without leaving binary float residue behind', async () => {
    const user = userEvent.setup();
    render(<Harness initial={1.2} step={0.1} />);
    await openStepper(user);

    // 1.2 - 0.1 是 1.0999999999999999。
    await user.click(screen.getByRole('button', { name: '减小局部色调' }));
    expect(input()).toHaveValue(1.1);
    await user.click(screen.getByRole('button', { name: '减小局部色调' }));
    expect(input()).toHaveValue(1);
  });

  it('heals a value an older build already left residue in', async () => {
    const user = userEvent.setup();
    // 老版本就是这样写进偏好里的：用户升级后不该继续在这一串上加减。
    render(<Harness initial={1.1500000000000001} step={0.1} />);
    await openStepper(user);

    await user.click(screen.getByRole('button', { name: '增大局部色调' }));
    expect(input()).toHaveValue(1.25);
  });

  it('keeps the extra decimals of a hand-typed value instead of snapping it onto the grid', async () => {
    const user = userEvent.setup();
    render(<Harness initial={1} step={0.1} />);
    await openStepper(user);

    // 输入框是原样透传的（半途的值交给 autosave 判断），所以步进只该消掉浮点残渣，
    // 不该把用户手敲的 1.125 吸到 0.1 的网格上。
    fireEvent.change(input(), { target: { value: '1.125' } });
    expect(input()).toHaveValue(1.125);
    await user.click(screen.getByRole('button', { name: '增大局部色调' }));
    expect(input()).toHaveValue(1.225);
  });

  it('still clamps the stepped value to the range', async () => {
    const user = userEvent.setup();
    render(<Harness initial={1.95} step={0.1} />);
    await openStepper(user);

    await user.click(screen.getByRole('button', { name: '增大局部色调' }));
    expect(input()).toHaveValue(2);
    expect(screen.getByRole('button', { name: '增大局部色调' })).toBeDisabled();
  });

  it('leaves integer steps alone', async () => {
    const user = userEvent.setup();
    render(<Harness initial={1} step={1} />);
    await openStepper(user);

    await user.click(screen.getByRole('button', { name: '增大局部色调' }));
    expect(input()).toHaveValue(2);
  });
});
