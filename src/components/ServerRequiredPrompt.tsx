import { RefreshIcon as RefreshCw } from './RefreshIcon';
import { Server } from 'lucide-react';
import { Link } from 'react-router-dom';

/** 「添加服务器」的图标：一格机架（指示灯 + 槽位）加右下角一枚加号。
 *
 * 上一版用的是通用箭头 `→`——那是「继续 / 下一步」的意思，放在「添加服务器」上什么
 * 也没说；lucide 的 `Server` 又只说「服务器」。这一枚把两件事合起来：机架是服务器，
 * 加号是添加。线条规格跟着应用里其它图标走（24 网格、currentColor、2px 圆头描边），
 * 所以在 17px 的按钮里和旁边的 `RefreshCw` 一样重。 */
function AddServerGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {/* 机架：一格机箱，左边一颗指示灯、右边一条槽位。 */}
      <rect x="2.5" y="3.5" width="19" height="7" rx="2" />
      <path d="M6.5 7h.01" />
      <path d="M10.5 7h4.5" />
      {/* 加号：这一台是「再加一台」。 */}
      <path d="M18 13.5v7" />
      <path d="M14.5 17h7" />
    </svg>
  );
}

/** The one prompt every page shows while no server is configured.
 *
 * 首页原来自己画了一版（上下两条分割线、左文案右按钮），书架与档案库各有一版
 * （没有分割线、左对齐），同一个状态三种长相。现在只有这一份，形状就是设置项那种
 * 容器：一个圆角描边卡片，说明居中，两个入口在底部自己的容器里。
 *
 * 外面那层 `.first-run-page` 管位置：三处宿主各加各的内边距（首页的 workspace 上边
 * 32px、档案库的列表面板 16px、书架不加），只靠 `.first-run` 自己排，同一个提示会
 * 在三个高度上出现。 */
export function ServerRequiredPrompt() {
  return (
    <div className="first-run-page">
      <section className="first-run" aria-labelledby="first-run-title">
        <div className="first-run-copy">
          <Server aria-hidden="true" />
          <p className="eyebrow">未连接</p>
          <h2 id="first-run-title">添加你的 LANraragi</h2>
          <p>服务器配置保存在本机；如果别的设备上已经配好，也可以从 WebDAV 或 S3 兼容存储同步恢复。</p>
        </div>
        {/* 两个入口并排一行，图标都在文字左边：竖排满宽像两条横幅，而图标一左一右
            时读起来像两种不同的东西。 */}
        <div className="first-run-actions">
          <Link className="primary-action" to="/settings">
            <AddServerGlyph />
            添加服务器
          </Link>
          <Link className="secondary-action" to="/settings?section=sync">
            <RefreshCw aria-hidden="true" />
            从云端同步
          </Link>
        </div>
      </section>
    </div>
  );
}
