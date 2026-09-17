import { ArrowRight, RefreshCw, Server } from 'lucide-react';
import { Link } from 'react-router-dom';

/** The one prompt every page shows while no server is configured.
 *
 * 首页原来自己画了一版（上下两条分割线、左文案右按钮），书架与档案库各有一版
 * （没有分割线、左对齐），同一个状态三种长相。现在只有这一份：居中、上下分割线
 * 一致，并给出两个入口——去设置里添加服务器，或从 WebDAV 备份把配置同步回来。 */
export function ServerRequiredPrompt() {
  return (
    <section className="first-run" aria-labelledby="first-run-title">
      <div className="first-run-copy">
        <Server aria-hidden="true" />
        <p className="eyebrow">未连接</p>
        <h2 id="first-run-title">添加你的 LANraragi</h2>
        <p>服务器配置保存在本机；如果别的设备上已经配好，也可以直接从 WebDAV 同步恢复。</p>
      </div>
      <div className="first-run-actions">
        <Link className="primary-action" to="/settings">
          添加服务器
          <ArrowRight aria-hidden="true" />
        </Link>
        <Link className="secondary-action" to="/settings?section=sync">
          <RefreshCw aria-hidden="true" />
          从 WebDAV 同步
        </Link>
      </div>
    </section>
  );
}
