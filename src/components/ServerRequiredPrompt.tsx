import { ArrowRight, RefreshCw, Server } from 'lucide-react';
import { Link } from 'react-router-dom';

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
        <div className="first-run-actions">
          <Link className="primary-action" to="/settings">
            添加服务器
            <ArrowRight aria-hidden="true" />
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
