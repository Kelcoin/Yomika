import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeErrorLogRepository } from '../../src/repositories/nativeErrorLogRepository';
import { NativeAppInfoRepository } from '../../src/repositories/nativeAppInfoRepository';

afterEach(resetInvokeAdapterForTests);

const buildInfo = {
  version: '1.0.0',
  buildTime: '1790000000',
  commit: 'abcdef123456',
  profile: 'release',
  identifier: 'app.yomika',
  platform: 'windows',
  os: 'windows',
  arch: 'x86_64',
};

describe('native error log bridge', () => {
  it('anonymizes legacy records and export contents at the repository boundary', async () => {
    const adapter = vi.fn(async (command: string) => command === 'error_log_read'
      ? { ok: true, value: [{ at: 'epoch:1', level: 'error', source: 'reader', message: 'failed https://private.example/api', detail: '{"serverId":"private-server"}' }] }
      : { ok: true, value: 'chosen.log' });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeErrorLogRepository();
    const response = await repository.list();
    expect(JSON.stringify(response)).not.toContain('private');
    await repository.exportTo('chosen.log', 'failed https://private.example/api');
    expect(adapter).toHaveBeenLastCalledWith('error_log_export', { path: 'chosen.log', contents: 'failed [REDACTED]' });
  });
  it('clears both rounds through the native bridge', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: 7 }));
    setInvokeAdapterForTests(adapter);
    expect(await new NativeErrorLogRepository().clear()).toEqual({ ok: true, value: 7 });
    expect(adapter).toHaveBeenCalledWith('error_log_clear', {});
  });

  it('reads this build\u2019s version and commit for the 相关信息 card', async () => {
    const adapter = vi.fn(async (command: string) => command === 'app_build_info'
      ? { ok: true, value: buildInfo }
      : { ok: true, value: { platform: 'windows', native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: true } });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeAppInfoRepository();
    expect(await repository.buildInfo()).toEqual({ ok: true, value: buildInfo });
    expect(adapter).toHaveBeenCalledWith('app_build_info', {});
    expect(await repository.platformName()).toEqual({ ok: true, value: 'windows' });
  });

  it('tolerates a build without stamped time and commit', async () => {
    // 手写的 cargo 构建（没跑 build.rs 的盖章步骤）不能把整块「相关信息」打掉：
    // 缺的项留空，界面按缺项处理。
    setInvokeAdapterForTests(async () => ({ ok: true, value: { ...buildInfo, buildTime: '', commit: '' } }));
    const result = await new NativeAppInfoRepository().buildInfo();
    expect(result.ok && result.value.commit).toBe('');
  });
});

describe('error log commands stay registered natively', () => {
  // 前端调的命令名必须在 Rust 侧存在，否则整块功能在真机上只是「点了没反应」。
  const registered = readFileSync(resolve(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');
  for (const command of ['error_log_clear', 'app_build_info']) {
    it(`registers ${command}`, () => {
      expect(registered).toContain(command);
    });
  }
});
