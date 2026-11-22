import { useState } from 'react';
import { Scale } from 'lucide-react';
import licenseText from '../../LICENSE?raw';
import inferenceNotices from '../../src-tauri/crates/compute-core/resources/ncnn/NOTICES.txt?raw';
import npuNotices from '../../src-tauri/resources/mobile-npu/NOTICES.txt?raw';
import realesrganLicense from '../../src-tauri/resources/models/Real-ESRGAN-LICENSE.txt?raw';
import { SettingsRow } from './SettingsRow';
import { SettingsMenu } from './SettingsValueControls';

export function AboutDetails() {
  const [open, setOpen] = useState(false);
  return <>
    {__APP_LICENSE__ && <SettingsRow icon={<Scale />} label="开源协议" value={__APP_LICENSE__} trailing="nav" onClick={() => setOpen(true)} />}
    {open && <SettingsMenu title="开源协议" icon={<Scale />} onClose={() => setOpen(false)}>
      <pre className="about-license-text">{licenseText}{'\n\n'+inferenceNotices+'\n\nReal-ESRGAN\n\n'+realesrganLicense+'\n\n'+npuNotices}</pre>
    </SettingsMenu>}
  </>;
}
