export const MODEL_MIRROR_PRESETS = [
  { id: 'direct', label: 'GitHub', prefix: '' },
  { id: 'gh-proxy', label: 'gh-proxy', prefix: 'https://gh-proxy.com/' },
  { id: 'ghfast', label: 'ghfast', prefix: 'https://ghfast.top/' },
  { id: 'ghproxy', label: 'ghproxy', prefix: 'https://ghproxy.net/' },
] as const;

export type ModelMirrorId = (typeof MODEL_MIRROR_PRESETS)[number]['id'] | 'custom';

export function buildModelAssetUrl(prefix: string, ownerRepo: string, tag: string, path: string): string {
  const target = `https://github.com/${ownerRepo}/releases/download/${encodeURIComponent(tag)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const normalized = prefix.trim().replace(/\/+$/, '');
  return normalized ? `${normalized}/${target}` : target;
}

export function mirrorPrefix(id: ModelMirrorId, custom = ''): string {
  if (id === 'custom') return custom.trim();
  return MODEL_MIRROR_PRESETS.find((preset) => preset.id === id)?.prefix ?? '';
}
