import { Component, type ErrorInfo, type ReactNode } from 'react';

import { logError } from '../lib/errorLog';

interface RenderGuardProps {
  children: ReactNode;
}

interface RenderGuardState {
  /** 非可选：`exactOptionalPropertyTypes` 下显式赋 `undefined` 才是「清掉」的意思。 */
  message: string | undefined;
}

/**
 * 渲染期抛错在 React 里的后果是**整棵子树被卸载**：窗口还在（Win32 层面一直可见），
 * 里面什么都没有。这个应用的窗口背景是 `rgba(11,11,15,0)`（tauri.conf 的
 * `backgroundColor: "#0B0B0F00"`，为了让自绘圆角透出桌面），所以卸载之后的观感就是
 * 「窗口消失了」——2026-10-14 用户报的「阅读模式点最大化/最小化之后窗口消失」最像这一
 * 形态：用 Win32 与 CDP 两条路探测都没看到窗口状态变化，日志里也没有崩溃记录，因为
 * **没人接住的渲染错误不会进 error.log**（`installErrorLogging` 只接 window 上的
 * error / unhandledrejection）。
 *
 * 这一层只做两件事：把抛错换成一块**看得见**的说明（不透明底色，保证不会又变成一片
 * 透明），以及把这次错误写进 error.log。样式故意写成内联：这件事不该依赖任何样式表
 * 是否加载成功——样式表本身出错也要能看见。
 */
export class RenderGuard extends Component<RenderGuardProps, RenderGuardState> {
  override state: RenderGuardState = { message: undefined };

  static getDerivedStateFromError(error: unknown): RenderGuardState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logError('render', '界面渲染出错，这一块被换成了说明', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  private readonly retry = (): void => {
    this.setState({ message: undefined });
  };

  override render(): ReactNode {
    const { message } = this.state;
    if (message === undefined) {
      return this.props.children;
    }
    return (
      <div
        role="alert"
        style={{
          alignItems: 'center',
          background: '#121412',
          color: '#f2f0ec',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'inherit',
          gap: '12px',
          inset: '0',
          justifyContent: 'center',
          padding: '24px',
          position: 'fixed',
          textAlign: 'center',
          zIndex: 2147483647,
        }}
      >
        <p style={{ margin: 0 }}>界面这一块渲染出错了，已记入错误日志。</p>
        <p style={{ margin: 0, opacity: 0.75, wordBreak: 'break-all' }}>{message}</p>
        <button
          type="button"
          onClick={this.retry}
          style={{
            background: '#2a2f2a',
            border: 0,
            borderRadius: '999px',
            color: 'inherit',
            cursor: 'pointer',
            padding: '8px 18px',
          }}
        >
          重新渲染
        </button>
      </div>
    );
  }
}
