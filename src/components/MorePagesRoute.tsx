import { usePreferences } from '../app/preferences';
import { compactNavHiddenItems } from './AppShell';
import { SettingsRow } from './SettingsRow';
import { StatusLine } from './StatusLine';

/** 底栏放不下的页面在这里列出来。
 *
 * 以前它是一个左上角的弹出菜单：点「更多」出面板、点外面关掉，键盘与读屏都要多绕
 * 一步，和设置页那种「一行一个入口」的语言也不一致。现在它是一张独立页面，行样式
 * 直接复用设置页的 SettingsRow，只是点了会跳转。哪些页面进来仍由底栏偏好决定——
 * 底栏装得下全部时连「更多」入口都不会出现。 */
export function MorePagesRoute() {
  const { preferences } = usePreferences();
  const hidden = compactNavHiddenItems(preferences.bottomNavItems);

  return (
    <div className="preferences-form">
      <div className="settings-group">
        <h1 className="visually-hidden">更多</h1>
        {hidden.length === 0
          ? <StatusLine>底栏已经放得下所有页面。</StatusLine>
          : hidden.map(({ to, label, icon: Icon }) => (
            <SettingsRow
              key={to}
              icon={<Icon />}
              label={label}
              trailing="nav"
              to={to}
              ariaLabel={`打开${label}`}
            />
          ))}
      </div>
    </div>
  );
}
