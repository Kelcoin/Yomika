import { usePreferences } from '../app/preferences';
import { compactNavHiddenItems } from '../lib/navigationOrder';
import { SettingsRow } from './SettingsRow';
import { PanelsTopLeft } from 'lucide-react';
import { EmptyState } from './EmptyState';
import { StateIcon } from './StateIcon';

/** Compatibility route for saved /more links; mobile navigation lives in the home header. */
export function MorePagesRoute() {
  const { preferences } = usePreferences();
  const hidden = compactNavHiddenItems(preferences.bottomNavItems);

  return (
    <div className="preferences-form">
      <div className="settings-group">
        <h1 className="visually-hidden">更多</h1>
        {hidden.length === 0
          ? <EmptyState icon={PanelsTopLeft} title="所有页面都在底栏中" description="可以直接通过底栏进入各个页面。" />
          : hidden.map(({ to, label, icon }) => (
            <SettingsRow
              key={to}
              icon={<StateIcon name={icon} />}
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
