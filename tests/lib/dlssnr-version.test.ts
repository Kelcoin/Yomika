import { describe, expect, it } from 'vitest';
import { formatSeries } from '../../src/domain/dlssnrVersion';

/**
 * 「适配哪些显卡」这句话由清单的结构化字段拼出来（用户 2026-10-18 要求把系列补回选项行，
 * 2026-10-17 又要求名字里别再塞系列——两件事要分开：名字短、系列另起一行）。
 */
describe('dlssnr version labels', () => {
  it('names the generations a snippet can run on, oldest first', () => {
    expect(formatSeries([50, 40])).toBe('RTX 40 / 50 系');
    expect(formatSeries([30, 20])).toBe('RTX 20 / 30 系');
    expect(formatSeries([50])).toBe('RTX 50 系');
  });

  it('says nothing when the catalog does not say which cards it covers', () => {
    // 清单里没有 series 的老条目仍然要能渲染：这一行干脆不出现，而不是写一句猜的话。
    expect(formatSeries(undefined)).toBeUndefined();
    expect(formatSeries([])).toBeUndefined();
  });
});
