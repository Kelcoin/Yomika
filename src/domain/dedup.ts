export interface DHashCandidate { id: string; hash: string; }
export interface DHashMatch extends DHashCandidate { distance: number; }

function validateHash(hash: string): void {
  if (!/^[0-9a-f]{16}$/i.test(hash)) throw new Error('dHash must be a 64-bit hexadecimal value');
}

export function dHashFromRgba(rgba: Uint8Array, width: number, height: number): string {
  if (width !== 9 || height !== 8 || rgba.length !== width * height * 4) throw new Error('dHash requires a 9x8 RGBA image');
  let bits = '';
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = (y * width + x) * 4;
      const right = left + 4;
      const leftGray = 0.299 * (rgba[left] ?? 0) + 0.587 * (rgba[left + 1] ?? 0) + 0.114 * (rgba[left + 2] ?? 0);
      const rightGray = 0.299 * (rgba[right] ?? 0) + 0.587 * (rgba[right + 1] ?? 0) + 0.114 * (rgba[right + 2] ?? 0);
      bits += leftGray < rightGray ? '1' : '0';
    }
  }
  let result = '';
  for (let offset = 0; offset < bits.length; offset += 4) result += Number.parseInt(bits.slice(offset, offset + 4), 2).toString(16);
  return result.padStart(16, '0');
}

export function hammingDistance(left: string, right: string): number {
  validateHash(left); validateHash(right);
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let value = Number.parseInt(left[index] ?? '0', 16) ^ Number.parseInt(right[index] ?? '0', 16);
    while (value) { distance += value & 1; value >>>= 1; }
  }
  return distance;
}

export function findDHashCandidates(hash: string, candidates: DHashCandidate[], threshold: number): DHashMatch[] {
  validateHash(hash);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 64) throw new Error('Invalid dHash threshold');
  return candidates.map((candidate) => ({ ...candidate, distance: hammingDistance(hash, candidate.hash) }))
    .filter((candidate) => candidate.distance <= threshold)
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
}
