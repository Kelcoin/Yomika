import { useState } from 'react';
import { Blocks, Scale } from 'lucide-react';
import licenseText from '../../LICENSE?raw';
import { SettingsRow } from './SettingsRow';
import { SettingsMenu } from './SettingsValueControls';

export function AboutDetails() {
  const [open, setOpen] = useState<'license' | 'build'>();
  return <>
    {__APP_LICENSE__ && <SettingsRow icon={<Scale />} label="开源协议" value={__APP_LICENSE__} trailing="nav" onClick={() => setOpen('license')} />}
    <SettingsRow icon={<Blocks />} label="构建于" value="Tauri 2 · React 18 · SQLite" trailing="nav" onClick={() => setOpen('build')} />
    {open && <SettingsMenu title={open === 'license' ? '开源协议' : '构建于'} icon={open === 'license' ? <Scale /> : <Blocks />} onClose={() => setOpen(undefined)}>
      {open === 'license' ? <pre className="about-license-text">{licenseText}</pre> : <div className="about-build-details">
        <p>Yomika v{__APP_VERSION__}</p>
        <p>Tauri 2 提供桌面与移动端原生宿主；React 18 构建交互界面；SQLite 保存本地档案索引、阅读进度与待看列表。</p>
      </div>}
    </SettingsMenu>}
  </>;
}
