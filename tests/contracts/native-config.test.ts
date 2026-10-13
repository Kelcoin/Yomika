import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DomainErrorCodeSchema } from '../../src/domain/errors';

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

/** 一个 TOML 段的正文：从表头那一行到下一个表头（或文件尾），不含表头自己。 */
function tomlSection(source: string, header: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) {
    throw new Error(`no ${header} in this manifest`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trimStart().startsWith('['));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

describe('native shell configuration', () => {
  it('registers model release and the reader commands, and none that run a model in this process', () => {
    const lib = read('../../src-tauri/src/lib.rs');
    // 名单里夹着行内注释（每一条都在说这条路为什么存在），先把注释去掉再切分：
    // 否则一条「注释 + 换行 + 命令名」会被当成一个条目，命令名就查不到了。
    const handlers = (lib.split('tauri::generate_handler![')[1]?.split(']')[0] ?? '')
      .split('\n')
      .map((line) => line.split('//')[0] ?? '')
      .join('\n');
    const registered = handlers.split(',').map((item) => item.trim()).filter(Boolean);
    for (const command of [
      'inference_install_decensor_bundle',
      'compute_submit_reader_page',
      'compute_submit_decensor_page',
      'model_release_download_bundle',
      'dlssnr_catalog',
      'dlssnr_download_variant',
    ]) {
      expect(registered).toContain(command);
    }
    // 这两条是「让宿主进程自己开模型算这一页」的入口（8-g③-ii 删掉）。算力都该走
    // worker：留着它们就等于留了一条绕开隔离的路，而前端早就不叫它们了（8-g②）。
    for (const gone of ['inference_upscale_page', 'inference_decensor_page']) {
      expect(registered).not.toContain(gone);
    }
  });

  it('leaves no renderer path that names a retired host model command', () => {
    // 上面那条看的是宿主名单，这条看渲染层：命令名只要还出现在任何一个文件里（哪怕
    // 只是一句注释），下一个人就会顺着它把旧路接回来。扫整棵树而不是写死几个文件名，
    // 正是为了让「新开一个文件又去调旧命令」也拦得住。
    const root = resolve(__dirname, '../..', 'src');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
      (entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'),
    );
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const entry of files) {
      const source = readFileSync(resolve(root, entry), 'utf8');
      for (const gone of ['inference_upscale_page', 'inference_decensor_page']) {
        if (source.includes(gone)) {
          offenders.push(`${entry}: ${gone}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ships a shell that does not link ONNX Runtime while the worker still does', () => {
    // 8-g③-iv 的出口条件之一：出厂的宿主二进制里没有 ONNX Runtime（`cargo tree -e normal`
    // 与 PE 导入表为证）。这条看的是清单：正常构建的那两份依赖段里不许出现 `ort`，也不许
    // 给 compute-core 开 `cpu`/`directml` —— 那两个 feature 就是核心那层 ONNX 会话层，
    // 宿主一开就等于把运行库链回主进程。
    const manifest = read('../../src-tauri/Cargo.toml');
    const runtime = [
      tomlSection(manifest, '[dependencies]'),
      tomlSection(manifest, '[target."cfg(windows)".dependencies]'),
    ].join('\n');
    expect(runtime).not.toMatch(/^\s*ort\s*=/m);
    expect(runtime).not.toMatch(/yomika-compute-core[^\n]*(?:cpu|directml)/);

    // 但测试二进制仍然要链：`inference/session.rs` 与 `inference/onnx.rs` 里那些真模型
    // 用例（GPU 与 CPU 对照、provider 归因、分块曲线）与 606 行的 Real-CUGAN parity
    // 夹具是 Task 1/7 的测量证据，删掉它们等于把证据一起删掉。`resolver = "2"` 保证
    // 出厂的 bin 构建不激活 dev-dependencies —— 所以证据与隔离可以同时成立。
    expect(tomlSection(manifest, '[dev-dependencies]')).toMatch(
      /yomika-compute-core[^\n]*cpu/,
    );
    const devWindows = tomlSection(manifest, '[target."cfg(windows)".dev-dependencies]');
    expect(devWindows).toMatch(/yomika-compute-core[^\n]*directml/);
    expect(devWindows).toMatch(/^\s*ort\s*=/m);

    // 隔离的另一半在 worker：真正开会话的是它，所以它必须继续带这两条 feature。
    const worker = read('../../src-tauri/worker/Cargo.toml');
    expect(tomlSection(worker, '[dependencies]')).toMatch(
      /yomika-compute-core[^\n]*cpu/,
    );
    expect(tomlSection(worker, '[target."cfg(windows)".dependencies]')).toMatch(
      /yomika-compute-core[^\n]*directml/,
    );
  });

  it('keeps the DLSSNR engine in the compute core and only a shell in the host', () => {
    // 8-g④：`docs/71` Task 8 的出口是「宿主无 ORT/NGX 资源」，而 NGX 只能在**计算进程**里
    // 初始化、worker 又不许依赖 Tauri（§5.2）——所以引擎（NGX 核心、D3D12 设备与工作区缓存、
    // 滤镜、动图、设置）只能住在 `compute-core` 那一层，宿主这边只剩命令壳与 DLL 的下载策略。
    // 这条看「哪一层有哪个文件」：它是这次搬迁**编译发现不了**的那一半——引擎文件放回宿主
    // 同样编得过（宿主本来就在 Windows 上链那些东西），只有清单与目录能说明它住哪。
    const engine = [
      'animation.rs',
      'device.rs',
      'filter.rs',
      'gpu.rs',
      'ngx.rs',
      'settings.rs',
      'workspace.rs',
    ];
    const host = readdirSync(resolve(__dirname, '../../src-tauri/src/dlssnr')).sort();
    expect(host).toEqual(['commands.rs', 'mod.rs', 'release.rs', 'testdata']);
    const core = readdirSync(
      resolve(__dirname, '../../src-tauri/crates/compute-core/src/dlssnr'),
    ).sort();
    for (const file of engine) {
      expect(core).toContain(file);
    }

    // 垫片跟着引擎走：编它的 build 脚本在核心那一层，宿主不再编（`cc` 因此也从产品段消失）。
    expect(read('../../src-tauri/build.rs')).not.toContain('ngx_shim');
    expect(read('../../src-tauri/crates/compute-core/build.rs')).toContain('ngx_shim.c');
    expect(tomlSection(read('../../src-tauri/Cargo.toml'), '[build-dependencies]')).not.toMatch(
      /^\s*cc\s*=/m,
    );

    // 宿主的产品依赖**不开** `dlssnr`（8-g④-b3）：那条 feature 装的是**引擎**（NGX 垫片 +
    // 设备/工作区/滤镜/动图），而宿主需要的只有元数据那一半（设置、变体身份、`dll_path`、
    // `output_revision`、探针记账、合成图与像素差、显卡枚举）。b1 把这一半从那条 feature
    // 下面挪出来，就是为了让这里能一条都不开；宿主清单的形状由下面
    // 「keeps the DLSSNR engine out of the shipped host…」那条用例守着（产品段不含 dlssnr、
    // 测试段含 dlssnr），这里只钉引擎那半自己带得动它的动图编解码器。
    const dlssnr =
      tomlSection(read('../../src-tauri/crates/compute-core/Cargo.toml'), '[features]')
        .split('\n')
        .find((line) => line.startsWith('dlssnr = ')) ?? '';
    for (const needed of ['dep:png', 'dep:image-webp', 'image/gif', 'image/webp']) {
      expect(dlssnr).toContain(needed);
    }
  });

  it('uses the approved product identity and a restrictive CSP', () => {
    const config = readJson('../../src-tauri/tauri.conf.json');

    expect(config).toMatchObject({ productName: 'Yomika', identifier: 'app.yomika.reader' });
    expect(JSON.stringify(config)).toContain("default-src 'self'");
    expect(JSON.stringify(config)).toContain('connect-src ipc: http://ipc.localhost');
  });

  it('keeps capabilities narrow', () => {
    const capability = readJson('../../src-tauri/capabilities/default.json');
    const serialized = JSON.stringify(capability);

    expect(capability).toMatchObject({ identifier: 'main', windows: ['main'] });
    expect(serialized).not.toMatch(/shell:|fs:allow-(?:home|app-data)-recursive|http:allow-fetch/);
    expect(serialized).toContain('core:app:default');
    expect(serialized).toContain('core:event:default');
  });

  it('starts schema versioning without plaintext secret columns', () => {
    const migration = read('../../src-tauri/migrations/0001_initial.sql');

    expect(migration).toContain('PRAGMA foreign_keys = ON');
    expect(migration).toContain('CREATE TABLE schema_migrations');
    expect(migration).toContain('CREATE TABLE settings');
    expect(migration).not.toMatch(/api_key\s|password\s|cookie\s|sync_secret\s/i);
  });

  it('registers only the foundation platform command', () => {
    const rust = read('../../src-tauri/src/lib.rs');

    expect(rust).toContain('platform_capabilities');
    expect(rust).not.toContain('std::process::Command');
    expect(rust).not.toContain('remove_dir_all');
  });

  it('defines the local library schema with scoped keys and no plaintext secrets', () => {
    const migration = read('../../src-tauri/migrations/0002_local_library.sql');

    for (const table of ['servers', 'archives', 'pages', 'reading_progress', 'cache_entries', 'tasks']) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration).toContain('PRIMARY KEY (server_id, archive_id)');
    expect(migration).toContain('PRIMARY KEY (scope_id, archive_id)');
    expect(migration).toContain('REFERENCES servers(id) ON DELETE CASCADE');
    expect(migration).not.toMatch(/api_key\s|password\s|cookie\s|sync_secret\s/i);
  });

  it('initializes SQLite migrations and registers scoped library commands', () => {
    const lib = read('../../src-tauri/src/lib.rs');
    const database = read('../../src-tauri/src/db/mod.rs');
    const commands = read('../../src-tauri/src/commands/library.rs');

    expect(lib).toContain('Database::open');
    expect(lib).toContain('list_archives');
    expect(lib).toContain('list_archives_by_ids');
    expect(lib).toContain('search_archives_page');
    expect(lib).toContain('save_reading_progress');
    expect(database).toContain('0001_initial.sql');
    expect(database).toContain('0002_local_library.sql');
    expect(database).toContain('crate::data_paths::data_dir(app)');
    expect(read('../../src-tauri/src/data_paths.rs')).toContain('app.path().app_data_dir()');
    expect(commands).toContain('connection.transaction()');
    expect(commands).toContain('WHERE server_id = ?1');
    expect(commands).toContain('ON CONFLICT(scope_id, archive_id)');
  });

  it('keeps the DLSSNR metadata usable without the engine feature', () => {
    // 引擎那一半（NGX 垫片、D3D12 设备、滤镜、工作区、动图逐帧）编进谁，谁的二进制里
    // 就有 NGX 与 d3d12。宿主迟早要摘掉这一份 feature（8-g④-b），所以纯元数据那一半
    // 必须能单独编出来：设置、变体身份、导入、探针缓存、合成图都不门 feature。
    const lib = read('../../src-tauri/crates/compute-core/src/lib.rs');
    expect(lib).toMatch(/#\[cfg\(windows\)\]\r?\npub mod dlssnr;/);
    expect(lib).not.toMatch(/cfg\([^)]*feature = "dlssnr"[^)]*\)\]\r?\npub mod dlssnr;/);

    const module = read('../../src-tauri/crates/compute-core/src/dlssnr/mod.rs');
    expect(module).toMatch(/pub mod settings;\r?\n/);
    for (const engine of ['animation', 'device', 'filter', 'ngx', 'workspace']) {
      expect(module).toMatch(
        new RegExp(`#\\[cfg\\(feature = "dlssnr"\\)\\]\\r?\\npub mod ${engine};`),
      );
    }

    // 显卡枚举（`gpu`，只调 DXGI）在元数据那一半：「这台机器有什么卡」是设置页要读的
    // 事实，不是引擎的执行。摘掉 feature 的宿主仍然答得出它（`DlssnrStatus.gpu`）。
    expect(module).toMatch(/\r?\npub mod gpu;\r?\n/);
    expect(module).not.toMatch(/feature = "dlssnr"\)\]\r?\npub mod gpu;/);

    // 「跑不跑得起来」的二次校验也不再要引擎：卡由调用方递进来。宿主要求的
    // `runtime_gate_with` 是不门的那一个（`ngx` 那一问留在有引擎的那一侧）。
    expect(module).toContain('pub fn runtime_gate_with(');
    expect(module).toMatch(/\r?\npub fn runtime_gate_with\(/);
    expect(module).not.toMatch(/feature = "dlssnr"\)\]\r?\npub fn runtime_gate_with\(/);

    // 图这个数据结构本身是纯的：探针要「合成一张图 + 比像素差」，摘掉引擎之后宿主
    // 还得用它，所以它跟着元数据那一半走，滤镜只借路径（`filter::DlssnrImage`）。
    const filter = read('../../src-tauri/crates/compute-core/src/dlssnr/filter.rs');
    expect(filter).not.toContain('pub struct DlssnrImage');
    expect(filter).toContain('pub use super::{DlssnrImage, MIN_EDGE};');

    // DLL 身份（`file_sha256`）在元数据那一半，`sha2` 就不能再挂在那份 feature 上。
    const manifest = read('../../src-tauri/crates/compute-core/Cargo.toml');
    expect(manifest).toMatch(/^sha2 = \{ version = "0\.10" \}$/m);
    expect(tomlSection(manifest, '[features]')).not.toContain('dep:sha2');
  });

  it('reads the installed snippet’s version off the file itself, and shows it where the snippet is named', () => {
    // 「装的是哪一条」与「装的是哪一版」是两件事：变体按我们认得的三种哈希回答，版本号
    // 只有文件自己的版本资源说得出来（用户导入一份社区新发的 DLL 时变体认不出，版本照样
    // 报得出来）。所以这里钉三件事：读的是 PE 的版本资源而不是我们自己编的表、读不出来
    // 就什么都不说、以及两个显示点用的是同一句话。
    const module = read('../../src-tauri/crates/compute-core/src/dlssnr/mod.rs');
    expect(module).toMatch(/pub fn dll_version\(path: &std::path::Path\) -> Option<String> \{/);
    // 问系统的版本资源：翻译表 → 那一种语言的 `FileVersion` 字符串（SF-v2 的
    // `310.8.SF.0` 只在这里），固定版本号那一支只当退路。
    expect(module).toContain('GetFileVersionInfoSizeW');
    expect(module).toContain('VerQueryValueW');
    expect(module).toContain('\\\\VarFileInfo\\\\Translation');
    expect(module).toContain('\\\\StringFileInfo\\\\{:04x}{:04x}\\\\FileVersion');
    expect(module).toContain('VS_FIXEDFILEINFO');
    expect(module).toContain('0xFEEF04BD');
    // 两份真片段的资源写法不同（官方原版 `310,8,0,0`、SF-v2 `310.8.SF.0`），摆在一列里
    // 得像同一个东西：只把分隔符统一成点分，数字一个不动。
    expect(module).toContain("text.replace(',', \".\")");
    // 这一条测试要真片段当夹具，缺了它必须红而不是静默跳过——否则干净检出会把它读成绿的。
    expect(module).toContain('fn the_shipped_dlls_report_the_version_windows_shows()');
    // 状态与回执各带一份：设置页读状态，导入/下载的回执拿它回一句话。
    expect(module).toMatch(/pub dll_version: Option<String>,/);
    expect(module).toMatch(/pub version: Option<String>,/);
    // 让 `dll_version` 编得起来的那个 feature：`GetFileVersionInfo*` 在
    // `Win32_Storage_FileSystem` 那一节里。
    expect(read('../../src-tauri/crates/compute-core/Cargo.toml')).toContain('"Win32_Storage_FileSystem"');
    // 前端：schema 收得下这个字段（老后端没有它，所以可选），两处显示共用同一句话。
    const repository = read('../../src/repositories/nativeDlssnrRepository.ts');
    expect(repository).toContain('dllVersion: z.string().nullable().optional(),');
    expect(repository).toContain('version: z.string().nullable().optional(),');
    const domain = read('../../src/domain/dlssnrVersion.ts');
    expect(domain).toContain('export function installedDllLabel(');
    expect(domain).toMatch(/return version \? ` · \$\{version\}` : '';/);
    const group = read('../../src/components/DlssnrSettingsGroup.tsx');
    // 两个显示点都用**认出来的那一条**的名字：社区把同一条重发之后内置表认不出它，
    // 名字得由清单按哈希说（`installedLabel`），不能退回 `status.variantLabel` 的空。
    expect(group).toContain(
      "installedDllLabel(installedLabel, status.dllPresent ? '认不出的片段' : '未安装', status.dllVersion)",
    );
    expect(group).toContain("installedDllLabel(installedLabel, 'nvngx_dlssnr', status.dllVersion)");
    expect(read('../../src/components/SettingsWorkspace.tsx')).toContain(
      "installedDllLabel(result.value.variantLabel, '自定义 DLL', result.value.version)",
    );
  });

  it('asks the worker which engines exist instead of this build asking itself', () => {
    // 宿主没有 NGX 垫片、也不该有：「这一份二进制有没有链上核心」对宿主永远是否定的，
    // 那不是这台机器的事实，是宿主这份二进制的样子。所以宿主不再自查核心；引擎那一侧
    // 有没有它，由 worker 握手时报的 `BuildInfo.engines` 说，卡的现状由 DXGI 说。
    const shell = read('../../src-tauri/src/dlssnr/mod.rs');
    const commands = read('../../src-tauri/src/dlssnr/commands.rs');
    const center = read('../../src-tauri/src/compute_center.rs');
    for (const [name, source] of [
      ['dlssnr/commands.rs', commands],
      ['compute_center.rs', center],
    ] as const) {
      expect(source, name).not.toMatch(/runtime_gate\(/);
      expect(source, name).toContain('runtime_gate_with(');
    }
    for (const [name, source] of [
      ['dlssnr/mod.rs', shell],
      ['dlssnr/commands.rs', commands],
      ['compute_center.rs', center],
    ] as const) {
      expect(source, name).not.toContain('NgxCore::available');
      expect(source, name).not.toContain('这个构建没有链上 NGX 核心');
    }
    expect(shell).toContain('engine_facts(');

    // 「还没有握手记录时，引擎就在 worker 里」这句的前提得是真的：宿主与 worker 是两次
    // 独立的 `-p` 解析（feature 不会互相传播，`cargo build --workspace` 那种会把它们并集
    // 起来，所以产品判据只能按包编），所以 worker 那一侧自己带着 DLSSNR 与 DirectML。
    const worker = read('../../src-tauri/worker/Cargo.toml');
    expect(tomlSection(worker, '[target."cfg(windows)".dependencies]')).toMatch(
      /yomika-compute-core[^\n]*"dlssnr"/,
    );

    // 而且「那一档叫什么」是**一个**字面量：worker 报的和宿主认的必须是同一个，所以它住在
    // 协议里（和 `PASSTHROUGH_ENGINE_ID` 同一类），两侧都不许自己另写一份。
    const protocol = read('../../src-tauri/crates/compute-protocol/src/messages.rs');
    expect(protocol).toContain('pub const DLSSNR_ENGINE_ID: &str = "dlssnr";');
    expect(shell).toContain('yomika_compute_protocol::DLSSNR_ENGINE_ID');
    const workerMain = read('../../src-tauri/worker/src/main.rs');
    expect(workerMain).toContain('yomika_compute_protocol::DLSSNR_ENGINE_ID');
    const workerDlssnr = read('../../src-tauri/worker/src/dlssnr.rs');
    expect(workerDlssnr).toContain('pub use yomika_compute_protocol::DLSSNR_ENGINE_ID;');
    expect(workerDlssnr).not.toContain('pub const DLSSNR_ENGINE_ID');
    expect(shell).not.toContain('engine == "dlssnr"');
    expect(workerMain).not.toContain('"dlssnr".to_string()');
  });

  it('runs the DLSSNR probe through the compute process instead of this one', () => {
    // 探针（设置页的「检测」）是最后一条还在宿主进程里真跑滤镜的路：它合成一张图、
    // 调 `apply`、比像素差。宿主没有 NGX 垫片，所以它要么失败、要么（从前）用的是宿主
    // 自己那份引擎——两种都不该发生。现在它把合成图编成 PNG 交给计算进程，拿回来的
    // 产物解码之后再比像素差；合成图与像素差本身是纯的，留在元数据那一半。
    const commands = read('../../src-tauri/src/dlssnr/commands.rs');
    expect(commands).toContain('probe_cached_with(');
    expect(commands).not.toMatch(/probe_cached\(/);
    expect(commands).toContain('crate::compute::proxy::dlssnr(');
    expect(commands).toContain('mean_absolute_difference(');
    for (const inProcess of ['apply_rgba(', 'apply_dlssnr(', 'filter::apply(']) {
      expect(commands, 'dlssnr/commands.rs').not.toContain(inProcess);
    }

    // 核心那一半把「怎么跑这一次」做成参数（`probe_cached_with` 的第三个参数），
    // 自己不再有那条真跑引擎的 `probe`——否则宿主随手一调就又回到本进程里算。
    const module = read('../../src-tauri/crates/compute-core/src/dlssnr/mod.rs');
    expect(module).toContain('pub fn probe_cached_with(');
    expect(module).not.toMatch(/feature = "dlssnr"\)\]\r?\npub fn probe_cached_with\(/);
    expect(module).not.toMatch(/feature = "dlssnr"\)\]\r?\npub fn probe\(/);
  });

  it('hands the DLSSNR workspace release to the compute process instead of this one', () => {
    // 工作区（NGX feature 的纹理，实测几个 GB 的提交内存）本来就在 worker 进程里。
    // 8-g④-b2c 之前宿主自己有一个 `release_cached_workspaces()` 壳：非 Windows 上恒 0，
    // Windows 上转到核心——转发的是**自己进程**的缓存，而宿主已经没有引擎了，所以那个
    // 数字永远没意义。现在两条入口都问 manager，由它去请 worker 交回。
    const commands = read('../../src-tauri/src/dlssnr/commands.rs');
    expect(commands).toContain('manager_from_app(&app)');
    expect(commands).toContain('manager.release_idle()');
    // 只钉**调用**（`super::release_cached_workspaces`），不钉那个名字：doc 里那句
    // 「见 `device::release_cached_workspaces` 上那段数字」说的是 worker 那边真交回的函数。
    expect(commands).not.toMatch(/super::release_cached_workspaces/);

    const shell = read('../../src-tauri/src/dlssnr/mod.rs');
    expect(shell).not.toContain('pub fn release_cached_workspaces');

    // 关窗进托盘那条路：**不等**回信（用户要的是窗口马上消失），请求本身还是发出去的。
    const lib = read('../../src-tauri/src/lib.rs');
    expect(lib).toContain('manager.release_idle_async()');
    expect(lib).not.toContain('release_cached_workspaces');

    // 宿主这一侧的形状：一条命令 + 一份回信口子，两边都认得协议里的那条消息。
    const manager = read('../../src-tauri/src/compute/manager.rs');
    for (const anchor of [
      'ReleaseIdle { reply: Sender<u32> }',
      'pub fn release_idle(&self)',
      'pub fn release_idle_async(&self)',
      'Message::ReleaseIdle(EpochOnly {',
      'Message::WorkspacesReleased(released)',
    ]) {
      expect(manager, 'compute/manager.rs').toContain(anchor);
    }

    // worker 那一侧：真的交回（核心那台引擎），并且**报回数字**——`count = 0` 与
    // 「没回话」必须能分开，否则「超时回 0」会把一次真实的交回记成没交。
    const protocol = read('../../src-tauri/worker/src/protocol.rs');
    expect(protocol).toContain('(options.release_workspaces)()');
    expect(protocol).toContain('Message::WorkspacesReleased(WorkspacesReleased {');
    expect(protocol).toContain('"workspaces_released"');
  });

  it('keeps the DLSSNR engine out of the shipped host while this process still answers the metadata questions', () => {
    // 「宿主无 NGX 资源」是 Task 8 的出口，而**产品**那一份与**测试**那一份不是同一个
    // feature 集合：resolver = "2" 让 `cargo build -p yomika` 只解析宿主的依赖图，而
    // `cargo test` 会把 dev-dependencies 并进来。所以判据落在清单的两段上，不落在某一个
    // 二进制上——二进制那一半由 `scripts/compute/task8g4b3-pe-evidence.ps1` 按包编了再看 PE。
    const manifest = read('../../src-tauri/Cargo.toml');
    const windowsDeps = tomlSection(manifest, '[target."cfg(windows)".dependencies]');
    const shipped = windowsDeps.split('\n').find((line) => line.startsWith('yomika-compute-core'));
    expect(shipped, 'Windows 产品依赖里要有 compute-core').toBeDefined();
    expect(shipped ?? '', '产品那一份不该开 dlssnr：开了 NGX 就会跟着垫片进宿主 exe').not.toContain(
      'dlssnr',
    );

    // 测试那一份仍然要真引擎：`src/dlssnr/mod.rs` 的
    // `the_engines_skip_notes_land_in_the_error_log` 得真跑一次 `apply_dlssnr`，才证得了
    // 「动图跳过的那行诊断落进了宿主的 error.log」。它只在测试构建里，出厂二进制看不见。
    const windowsDevDeps = tomlSection(manifest, '[target."cfg(windows)".dev-dependencies]');
    const tested = windowsDevDeps
      .split('\n')
      .find((line) => line.startsWith('yomika-compute-core'));
    expect(tested, 'Windows 测试依赖里要有 compute-core').toBeDefined();
    expect(tested ?? '', '日志口那条用例要真引擎').toContain('dlssnr');
    expect(tested ?? '', 'DirectML 会话语义仍在测试里').toContain('directml');

    // 引擎搬走之后，宿主自己不再编 APNG 与动图 WebP：那两行是那套编码器还在宿主进程里时
    // 留下的，宿主源码里现在一处 `png::` / `image_webp::` 都没有（只有 `image` 的
    // `image::codecs::png::PngEncoder`）。留着它们，下一个人会以为宿主还在编动图。
    const deps = tomlSection(manifest, '[dependencies]');
    expect(deps, '宿主不再直接依赖 png').not.toMatch(/^png\s*=/m);
    expect(deps, '宿主不再直接依赖 image-webp').not.toMatch(/^image-webp\s*=/m);
  });

  it('replaces the worker generation when a new DLSSNR snippet arrives', () => {
    // docs/71:640「模型/DLL换版本重启worker；不能热切同NGX context的DLL；通过epoch清旧
    // 结论与source/output revision」。片段的 context 活在 worker 进程里，所以「换片段」在
    // 宿主这一侧只有一个形状：**请这一代退下**——把宿主的旧结论忘掉是不够的，那一代还会拿
    // 新片段去要一份它拒绝给的新 context，用户看到的仍是旧片段跑出来的图。
    const commands = read('../../src-tauri/src/dlssnr/commands.rs');
    expect(commands).toContain('fn a_new_snippet_arrived(');
    expect(commands).toContain('manager.retire_worker("DLSSNR 片段换了版本")');
    // 两条装片段的入口（导入文件 / 下载变体）都要换代；旧做法（只 `forget_probe`）不该
    // 留在调用点上——那正是「换了片段但那一代还在跑」。
    expect(
      commands.match(/a_new_snippet_arrived\(&app\);/g) ?? [],
      '两条装片段的入口都要换代',
    ).toHaveLength(2);
    expect(commands.match(/super::forget_probe\(\);/g) ?? [], '作废探针只在助手体内发生一次').toHaveLength(1);

    // 宿主这一侧的形状。
    const manager = read('../../src-tauri/src/compute/manager.rs');
    expect(manager).toContain('pub fn retire_worker(&self, reason: &str) -> bool');
    expect(manager).toContain('Command::RetireWorker {');
    expect(manager).toContain('fn close_session(&mut self, reason: &str)');
    // **故意的换代不是崩溃**：走优雅收尾那条路。`lose_session` 会把这一次算进重启窗口的账，
    // 用户在设置页连换四次片段就会把熔断点亮（而它一次都没崩过）。
    expect(manager).toContain('self.close_session(reason.as_str())');
    expect(manager).not.toContain('self.lose_session(reason.as_str()');
  });

  it('stops a remote page when the client that asked for it goes away', () => {
    // docs/71:641「远端请求走同scheduler/artifact，认证/ping不等GPU，断连取消独立subscription」。
    // 前两句各有行为证据（`src-tauri/tests/remote_compute_center.rs` 的 ①②：同一条调度/产物路、
    // 慢任务在飞时 ping 与 capabilities 照答），这一条钉的是第三句——「独立 subscription」不是
    // 一句愿望：对面走了要停的是**它自己那一次订阅**，不是这台机器上这个概念。
    const center = read('../../src-tauri/src/compute_center.rs');
    // 取消牌得从**这条连接**上读来。写死 `&|| false` 就是今天那个「对面把连接丢了，我们还把
    // 这一页打算了」——三条来路的取消全是同一个形状，所以这条断言落在整个文件上。
    expect(center, '远端那条来路不许把取消写死').not.toContain('&|| false');
    expect(center, '读端要单独拆出来才看得见对面走了').toContain('tokio::io::split(');
    expect(center, '进程那张票要能收下取消牌').toMatch(
      /pub fn process\([\s\S]*?bytes: &\[u8\],\r?\n\s*cancelled: &dyn Fn\(\) -> bool,/,
    );
    // 断连怎么变成取消牌：读端一个任务，读到 EOF（对面走了）就翻牌。
    expect(center).toMatch(/reader\s*\.\s*read\(/);
    expect(center).toContain('gone.store(true');
    // 编排只该有一个来源。测试里没有 AppHandle，所以壳要能直接收下一份——否则这条协议只能
    // 靠「起一个真 Tauri 应用」来测，等于没有自动化证据。
    expect(center).toContain('pub manager: Option<Arc<crate::compute::manager::ComputeManager>>');
    // 认证与 ping 排在计算之前：ping 的回答只有服务名与版本，不查令牌、不碰编排。
    const ping = center.indexOf('request.path == "/v2/ping"');
    const gate = center.indexOf('let expected = token.read()');
    expect(ping, 'ping 那一支要在').toBeGreaterThan(-1);
    expect(gate, '令牌检查在 ping 之后').toBeGreaterThan(ping);
  });

  it('reclaims the staging tree when a session ends and keeps the scratch name in one place', () => {
    // docs/71:642 后半「idle/release/shutdown回收所有可回收资源」。staging 是 worker 唯一
    // 能写的地方，里面三种东西：正在飞的那一件、已经发布过的那份副本、worker 自己攒的暂存
    // 子树（NGX 片段，`worker/src/dlssnr.rs` 拿它当数据目录）。后两种在会话收摊之后都是垃圾
    // ——收摊之前不能动（可能正写着），收摊之后不收，就是会话越多攒越多。
    const manager = read('../../src-tauri/src/compute/manager.rs');
    expect(manager).toContain('fn reclaim_staging(shared: &Shared)');
    // 两个「确定没有写者」的时刻：握手刚谈成、进程真退出之后。少一处就有一半的垃圾永远
    // 留在盘上——只有换代那条路经过握手，只有优雅收尾那条路经过收摊。
    expect(
      manager.match(/reclaim_staging\(&self\.shared\);/g) ?? [],
      '握手与收摊各一处',
    ).toHaveLength(2);
    const terminated = manager.indexOf(
      'terminate_process(&mut session, self.shared.config.shutdown_grace)',
    );
    const reclaimed = manager.indexOf('reclaim_staging(&self.shared);', terminated);
    expect(terminated, '这一行要在').toBeGreaterThan(-1);
    expect(reclaimed, '清扫排在 terminate_process 之后').toBeGreaterThan(terminated);

    // 认哪棵子树只能有一个名字：宿主扫 staging 根下叫 `dlssnr-ngx` 的那棵目录，worker 往
    // 里面写片段。各写一份字面量，漂了不报错，只会让那份片段永远攒着。
    const protocol = read('../../src-tauri/crates/compute-protocol/src/messages.rs');
    expect(protocol).toContain('pub const SCRATCH_DIR_NAME: &str = "dlssnr-ngx";');
    const worker = read('../../src-tauri/worker/src/dlssnr.rs');
    // 这一条断言在前、那条 `not.toContain` 在后：**只要 worker 抄回一份字面量，两条里先红
    // 的必然是这一条**（字面量一进来，引用就没了）。所以「这不许发生」那句话挂在它身上，
    // 变异才钉得住——挂在后一条上，红是红了，红的却是另一条断言。
    expect(
      worker,
      'worker 这一侧不许再抄一份字面量（只能引协议里那一份）',
    ).toContain('const DATA_DIR_NAME: &str = yomika_compute_protocol::SCRATCH_DIR_NAME;');
    expect(worker, 'worker 这一侧不许再抄一份字面量').not.toContain('"dlssnr-ngx"');

    // 只收自己那棵：别人的目录、链接一概不碰；也绝不整棵删（`remove_dir_all` 会跟着链接
    // 删）。断言落在那个函数体上——整份文件里还有测试沙箱在用 `fs::remove_dir_all`。
    const artifacts = read('../../src-tauri/src/compute/artifacts.rs');
    expect(artifacts).toContain('name == SCRATCH_DIR_NAME');
    const sweep = artifacts.slice(artifacts.indexOf('fn sweep_scratch_dir('));
    const sweepBody = sweep.slice(0, sweep.indexOf('\n}'));
    expect(sweepBody, 'symlink/junction 不跟进去').toContain('is_reparse_point(&metadata)');
    expect(sweepBody, '收空之后删的是目录本身').toContain('fs::remove_dir(&path)');
    expect(sweepBody, '绝不整棵删').not.toContain('remove_dir_all');
  });

  it('leaves this process no product path into a heavy engine, only the pure metadata helpers', () => {
    // docs/71:643「清除宿主所有调用heavy算法的实际入口，保留按需计算纯元数据helper；核对PE/module列表」。
    // 判据不是「谁提了引擎的名字」：按需纯元数据壳（`status_with`/`probe_cached_with` 把**事实**
    // 当参数收下）与 DXGI 枚举本来就该留在宿主这一侧。判据是**跑引擎**的那一类名字，规则一条：
    // 宿主 `src/**` 的产品码里一次都不许出现，只许出现在文件自己的 `mod tests` 里（注释不算
    // ——注释正是在说明这件事）。唯一的例外是整份只有测试用的模块，它的父模块声明里钉着
    // `#[cfg(test)]`（那一条在下面单独断言）。宿主今天算的只剩内置 shader 链与无模型最近邻。
    const engineCalls =
      /\bapply_rgba\(|\bapply_dlssnr\(|\bapply_with_token|\bapply_with_dll|device::with_context|OnnxEngine|\bort::|ngx::NgxCore|filter::apply|release_cached_workspaces/;
    const testOnly = new Set(['inference/onnx.rs']);
    // 路径先落到变量上：`new URL('字面量', import.meta.url)` 会被 Vite 的资产改写插件
    // 换成 dev-server 的 http 地址，`fileURLToPath` 当场报「The URL must be of scheme file」。
    const sourceRoot = '../../src-tauri/src';
    const root = fileURLToPath(new URL(sourceRoot, import.meta.url));
    const walk = (dir: string, prefix: string): string[] => {
      const found: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          found.push(...walk(resolve(dir, entry.name), `${prefix}${entry.name}/`));
        } else if (entry.name.endsWith('.rs')) {
          found.push(`${prefix}${entry.name}`);
        }
      }
      return found;
    };
    const files = walk(root, '');
    expect(files.length, '宿主的 Rust 源码没扫到东西，这条判据会变成空的').toBeGreaterThan(50);

    const offenders: string[] = [];
    let engineCallsSeen = 0;
    for (const file of files) {
      const lines = readFileSync(resolve(root, file), 'utf8').split(/\r?\n/);
      const testsAt = lines.findIndex((line) => /^\s*(pub )?mod tests\b/.test(line));
      lines.forEach((line, index) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) {
          return;
        }
        if (!engineCalls.test(code)) {
          return;
        }
        engineCallsSeen += 1;
        // 注意 `testsAt >= 0`：文件里没有 `mod tests` 时 `findIndex` 给的是 -1，
        // 少了这一半，`index > testsAt` 会把**每一次**命中都放过去（判据自己变空）。
        if (testOnly.has(file) || (testsAt >= 0 && index > testsAt)) {
          return;
        }
        offenders.push(`${file}:${index + 1}: ${code}`);
      });
    }
    expect(offenders, '宿主产品码里出现了跑引擎的调用').toEqual([]);
    // 扫描本身也要有牙：今天宿主源码里这类名字有二十来处（全在测试里）。一处都扫不到说明
    // 正则或遍历坏了，那和「没有违规」是两件完全不同的事。
    expect(engineCallsSeen, '扫到的引擎调用次数').toBeGreaterThan(15);

    // 保留的那几样，一条一条点名——「保留按需纯元数据 helper」不是一句形容词：
    const commands = read('../../src-tauri/src/dlssnr/commands.rs');
    expect(commands, '状态那半只收事实').toContain(
      'super::status_with(&data, super::engine_facts(build.as_ref()))',
    );
    expect(commands, '探针那半只收一段要跑的闭包').toContain(
      'super::probe_cached_with(&data, force, ||',
    );
    // 卡是「这台机器」的事实，DXGI 枚举留在这里（它不碰 D3D12、更不碰 NGX）
    expect(read('../../src-tauri/src/dlssnr/mod.rs')).toContain(
      'gpu: yomika_compute_core::dlssnr::gpu::detect_gpu().ok().flatten(),',
    );
    // 宿主自己算的那一档只有 Anime4K 与最近邻；ONNX 那一档要**顶回去**（分流断了就明说），
    // 不许拿别的引擎顶替——顶替会让人以为「模型效果就这样」。
    const inference = read('../../src-tauri/src/inference.rs');
    expect(inference, 'ONNX 那一档要顶回去，不许拿别的引擎顶替').toContain(
      'Some(ResolvedUpscaler::Onnx(_, _)) => {',
    );
    expect(inference, '顶回去的时候要说清楚该去哪儿算').toContain(
      '这一档要交给计算进程算，宿主这里没有它',
    );
    // ORT 那条缝只能是测试：模块声明本身挂在 `#[cfg(test)]` 下，产品构建里连这个模块都不
    // 存在——谁在产品码里用上它，会以「找不到模块」当场红，而不是悄悄把运行库链回主进程。
    expect(inference, 'ORT 那条缝只能是测试：产品构建里连模块都不存在').toMatch(
      /#\[cfg\(test\)\]\r?\npub mod onnx;/,
    );
    // `session` 这一份是**不门**的（产品半只有 `backend_of` 那句词汇翻译）：所以它的 ORT
    // 必须待在文件自己的 `mod tests` 里——上面那条扫描规则对它同样有效。
    const session = read('../../src-tauri/src/inference/session.rs');
    expect(session.indexOf('use ort::'), 'ORT 只能在测试模块里').toBeGreaterThan(
      session.indexOf('mod tests {'),
    );
    // 垫片跟着 feature 走：不开 dlssnr 的构建连它都不编（`include_bytes!` 那份从哪来）
    const build = read('../../src-tauri/crates/compute-core/build.rs');
    expect(build, '非 Windows 目标连工具链都不去找').toContain(
      'if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {',
    );
    expect(build, '垫片跟着 feature 走：不开 dlssnr 的构建连它都不编').toContain(
      'if std::env::var_os("CARGO_FEATURE_DLSSNR").is_none() {',
    );
  });

  it('keeps one NGX context per epoch in the worker, with the guards that prove it', () => {
    // docs/71:639「NGX初始化只在worker，每个epoch一份合法context，保留COM引用计数红/绿守卫、
    // 取消后workspace状态及动画测试」。
    //
    // 这一条问的不是「搬得对不对」，而是**搬完之后还剩下什么**：8-e…8-g④ 把引擎整份搬进计算
    // 进程，路上最容易丢的不是代码，是守卫——守卫丢了不会有任何东西变红，要等下一次真机故障
    // 才暴露。所以四半句各钉两样：结构，以及**让它有牙的那句断言**（只钉函数名的话，把断言
    // 掏空照样是绿的）。第 19 条钉的是宿主那一侧的负向（产品码里没有跑引擎的调用），这里钉
    // worker 那一侧的正向。
    const workerDlssnr = read('../../src-tauri/worker/src/dlssnr.rs');
    expect(workerDlssnr, '片段落盘与 NGX 初始化只能发生在计算进程这一侧').toContain(
      'self.install_feature(&data_dir, &grant.feature)?;',
    );
    // 取消标志要真的走进核心那两扇门：静态一扇、动图一扇。留在门口不往下传，「取消之后这一页
    // 停下来」就只是宿主那边的错觉。
    expect(workerDlssnr, '静态那一页的取消标志要传到核心').toContain(
      'filter::apply_with_token(&data_dir, &image, &settings, request.cancel)',
    );
    expect(workerDlssnr, '动图那一页走逐帧那条路，取消标志同样要传下去').toContain(
      'apply_dlssnr(&data_dir, &source, &settings, request.cancel)',
    );
    // 空闲回收把条数报回去那一句：「交回 0 份」与「没问过」在宿主那边必须能分开。
    expect(
      read('../../src-tauri/worker/src/lib.rs'),
      '交回工作区要如实报回条数（0 也是一个答案）',
    ).toContain('yomika_compute_core::dlssnr::release_cached_workspaces() as u32');

    // ② 每个 epoch 一份合法 context：进程级单槽 + 换不掉就明确报错。`Rebuild` 那一格要真的
    // 初始化一遍 NGX（进程内不该再试第二次），所以「一份」这件事只有决策表测得起——那条测试
    // 不碰真设备，下面点名。
    const device = read('../../src-tauri/crates/compute-core/src/dlssnr/device.rs');
    expect(device, '上下文缓存是进程级的单槽：一个进程一份').toContain(
      'static CONTEXT: OnceLock<Mutex<ContextState>>',
    );
    expect(device, '缓存里已经是另一份片段（或另一个数据目录）时只能报错：NGX 换不掉').toContain(
      'SlotStep::AlreadyInitialized',
    );
    expect(device, '换片段之后要叫人重启，不许当没看见').toContain(
      '换过 DLL 之后要重启应用才会用新的那一份',
    );
    expect(device, '决策表要有一条不碰真设备就能跑的测试').toContain(
      'fn the_slot_keeps_one_context_and_remembers_a_failure_per_dll()',
    );
    // 光钉函数名挡不住「把断言掏空」：那两格（另一份片段、另一个数据目录）在测试里各断一次，
    // 数一数它们还在不在——把 `slot_step` 改成允许热切，红的正是这条测试。
    const slotTable = device.slice(
      device.indexOf('fn the_slot_keeps_one_context_and_remembers_a_failure_per_dll()'),
    );
    const slotBody = slotTable.slice(0, slotTable.indexOf('\n    }'));
    expect(
      (slotBody.match(/SlotStep::AlreadyInitialized/g) ?? []).length,
      '「换不掉」那两格（另一份片段、另一个数据目录）都要钉在测试里',
    ).toBeGreaterThanOrEqual(2);
    // epoch 的身份：worker 侧握手时就认（「你找的是不是我这个 epoch」正是握手要回答的事），
    // 迟到/串台的普通消息丢掉但不弄死会话；宿主侧旧 epoch 的事件不许改今天的账，更不许过
    // 发布的闸（换过进程之后旧结论落进正式目录，就是一台机器上两份真相）。
    const workerProtocol = read('../../src-tauri/worker/src/protocol.rs');
    expect(workerProtocol, 'epoch 不对要在握手那一步就说清楚').toContain(
      'return Ok(SessionOutcome::EpochMismatch);',
    );
    // `indexOf` 找不到时给的是 -1，而 `-1 < 后面那一处` 恒真——没有上面那条 `toBeGreaterThan(-1)`，
    // 把这句话整个删掉反而能让下面那条断言「过」（第 19 条里 `testsAt >= 0` 是同一个坑）。
    const epochMismatchAt = workerProtocol.indexOf('SessionOutcome::EpochMismatch');
    expect(epochMismatchAt, '握手阶段那条返回要在').toBeGreaterThan(-1);
    expect(
      epochMismatchAt,
      'epoch 过滤要排在握手之后（握手正是回答「你找的是不是我这个 epoch」的地方）',
    ).toBeLessThan(workerProtocol.indexOf('if !message.matches_epoch('));
    expect(workerProtocol, '旧的迟到/串台消息丢掉，但别把整个会话弄死').toContain(
      '旧 worker 迟到/串台的消息：不处理，但也别把整个会话弄死',
    );
    expect(
      read('../../src-tauri/src/compute/scheduler.rs'),
      '旧 epoch 的事件不许改今天的账',
    ).toContain('fn events_from_an_old_worker_epoch_are_ignored()');
    expect(
      read('../../src-tauri/src/compute/artifacts.rs'),
      '发布也要认 epoch：旧结论不许落进正式目录',
    ).toContain('pub fn publish_allowed(');

    // ③ COM 引用计数的红/绿守卫：每条记录下来的命令描述符都得在记录之后放掉自己那次 AddRef，
    // 否则每页都会把 upload / readback / 纹理钉到进程退出。三个计数断言就是它红的地方。
    expect(device, 'COM 引用计数的守卫要在').toContain(
      'fn recording_page_commands_does_not_leak_com_references()',
    );
    expect(device, '它守的是什么要写着（描述符里的 COM 字段是 ManuallyDrop）').toContain(
      'Each clone must release',
    );
    expect(device, '上传描述符漏引用要红').toContain('upload descriptor leaked a COM reference');
    expect(device, '回读描述符漏引用要红').toContain('readback descriptor leaked a COM reference');
    expect(device, '拷贝/屏障漏的是纹理自己的引用，也要红').toContain(
      'copy/barrier descriptors leaked texture references',
    );

    // ④ 取消后的 workspace 状态与动图：取消不该动上下文、不该丢工作区；交回工作区要真的把
    // 纹理放掉（不是只改计数器）；一次提交失败只丢那一份上下文，不许把它放大成「后面每一页
    // 都失败」。
    const core = read('../../src-tauri/crates/compute-core/src/dlssnr/mod.rs');
    expect(core, '取消不该动上下文与工作区').toContain(
      'fn a_cancelled_page_keeps_the_context_and_its_workspace()',
    );
    expect(core, '取消不该把上下文作废掉').toContain('取消不该把上下文也作废掉');
    expect(core, '取消不该把工作区丢掉（那一页没提交过任何命令，纹理还在开场状态）').toContain(
      '取消不该把工作区丢掉：被取消的那一页没有提交过任何命令，纹理还在开场状态',
    );
    expect(core, '交回工作区要真的放掉纹理').toContain(
      'fn releasing_the_cached_workspaces_gives_the_textures_back()',
    );
    expect(core, '一个都没放掉要红').toContain('缓存里明明有工作区，却一个都没放掉');
    expect(core, '放完还挂着要红').toContain('交回之后缓存里不该还挂着工作区');
    // 「条数归零」与「逐像素相同」都分不出「还回去」与「丢掉」：把 `workspace.release(core)`
    // 换成 `workspaces.clear()` 实测照样绿（第 42 轮量的）。所以这条守卫的牙在第四个观察量上，
    // 它也得被钉住——不然下一个人只留前三条，假回收就又能过。
    expect(core, '交回工作区要真的还回 NGX，不许「丢掉」了事').toContain(
      '工作区是「丢掉」的，不是「还回 NGX」的',
    );
    expect(
      read('../../src-tauri/crates/compute-core/src/dlssnr/ngx.rs'),
      '那个不会撒谎的观察量要在：数 release_feature 真的被调了几次',
    ).toContain('pub(super) fn released_features() -> u64');
    expect(core, '一次提交失败只丢那一份上下文').toContain(
      'fn a_failed_submit_drops_the_context_instead_of_poisoning_every_page()',
    );
    expect(core, '作废之后要能自己恢复').toContain('作废之后要能自己恢复');
    expect(core, '重建的份数也要对').toContain('作废的上下文之后必须重建，而且只重建一份');
    const animation = read('../../src-tauri/crates/compute-core/src/dlssnr/animation.rs');
    expect(animation, '动图取消要在帧之间停手').toContain(
      'fn stops_between_frames_when_the_task_is_cancelled()',
    );
    expect(animation, '取消之后不许再跑第二帧').toContain('取消之后不该再跑第二帧');
    expect(animation, '取消报的是那个稳定信号').toContain('crate::dlssnr::filter::CANCELLED');

    // ⑤ 「保留」这两个字得查得动：上面这些守卫在没 DLL / GPU 起不来时会打印跳过就走，而跳过的
    // 用例在 `test result` 里照样算 passed——所以三连必须把那几个记号当成「没量到」，而且
    // `core-dlssnr` 那一步必须 `--nocapture`（不然记号根本进不了日志，判据本身是空的）。
    expect(core, '没 DLL 时要留下能分辨的记号').toContain('跳过：没有找到 nvngx_dlssnr.dll');
    expect(core, '真跑不起来也要留下记号').toContain('跳过：DLSSNR 没跑起来');
    expect(device, 'COM 那条守卫的记号别改名').toContain('SKIP: no DLSSNR DLL');
    const verify = read('../../scripts/compute/verify-round.ps1');
    expect(verify, 'core-dlssnr 那一步要 --nocapture').toMatch(
      /Step "core-dlssnr" \{[^}]*--nocapture/,
    );
    expect(verify, '三连要把「跳过」认成「没量到」').toContain("'跳过：没有找到 nvngx_dlssnr.dll'");
    expect(verify, '真跑不起来那一档也要认').toContain("'跳过：DLSSNR 没跑起来'");
    expect(verify, 'COM 那条守卫的记号也要认').toContain("'SKIP: no DLSSNR DLL'");
    expect(verify, '要留一个显式的放行口，不然没片段的机器永远过不了').toContain(
      'YOMIKA_ALLOW_VACUOUS_GUARDS',
    );
  });

  it('gives way under pressure instead of failing the page the user opened', () => {
    // §8.1 的软/硬阈值与 §8.4 的显存预留：机器吃紧时该丢的是**后台预扫**，不是用户正等着的
    // 那一页。这条钉住三层各自的形状——只钉一层的话，把压力判断整个接到别处也能过。
    const policy = read('../../src-tauri/src/compute/resource_policy.rs');
    expect(policy, '档位要有一个名字').toContain('pub enum Admission {');
    expect(policy, '量不到就读成空，而不是读成没压力').toContain(
      'pub fn unknown() -> Self',
    );
    expect(policy, '硬压力下连前台也不收').toContain(
      'CommitPressure::Hard => return Admission::Refuse',
    );
    expect(policy, '显存预留那条要真的被用上').toContain('gpu_reserve_satisfied(free, total)');

    const scheduler = read('../../src-tauri/src/compute/scheduler.rs');
    expect(scheduler, '压力是一档单独的结果，不是「这一页不能算」').toContain(
      'Pressure,',
    );
    expect(scheduler, '准入要在提交那一刻判').toContain('pub fn submit_under(');
    expect(scheduler, '老调用点不该被这次改动牵着走').toContain(
      'self.submit_under(key, priority, now_ms, Admission::Run)',
    );
    expect(scheduler, '要能把排队中的后台丢掉').toContain(
      'pub fn shed_background(&mut self, now_ms: u64) -> Vec<String>',
    );
    const shed = scheduler.slice(scheduler.indexOf('pub fn shed_background('));
    expect(shed, '丢掉的后台要有结论，不能悬着').toContain('JobState::Cancelled');
    expect(shed, '结算要用调用方给的那一刻').toContain('self.settle(job_id, JobState::Cancelled, now_ms)');

    const manager = read('../../src-tauri/src/compute/manager.rs');
    expect(manager, '量的是 worker 自己的私有提交').toContain('fn private_commit_of(pid: u32)');
    expect(manager, '显存预算取 DXGI 那份读数').toContain(
      'yomika_compute_core::dlssnr::gpu::video_memory()',
    );
    expect(manager, '每拍都要采一次读数').toContain('fn sampled_pressure(child: Option<&Child>)');
    expect(manager, '档位一差就清排队中的后台').toContain('self.shed_background();');
    expect(manager, '硬压力下连在跑的后台也收').toContain('self.cancel_background_running();');
    expect(manager, '收后台要有理由，界面才说得清').toContain('机器吃紧，先把后台预扫收掉');

    const commands = read('../../src-tauri/src/compute/commands.rs');
    expect(commands, '压力拒收要报成能重试的错，不是故障').toContain(
      'Err(SubmitError::Pressure) => CommandResult::failure(',
    );
    expect(commands, '拒收用的是能重试的那一档码').toContain('"COMPUTE_UNAVAILABLE",');
    expect(commands, '要告诉用户原图还在、等会儿会自己再试').toContain('等会儿再看会自动重试');

    // 判据要能被跑起来验：test 里的压力走注入口（真去压机器的话，换台电脑就是随机红）。
    const it = read('../../src-tauri/tests/compute_manager.rs');
    expect(it, '压力那一条要留着').toContain(
      'fn a_machine_under_pressure_sheds_the_background_and_still_takes_the_page_you_opened()',
    );
    expect(it, '读数要能喂进来，测试才不靠机器').toContain('PressureSource::Injected(gauge.clone())');
  });

  it('measures a page before handing it over instead of letting the worker find out', () => {
    // §12.4 ③（大页规格）与 Task 9 ①（超限要明示失败）：一页装不下时，判决要在**派发前**就落下
    // ——worker 也会拒（`dlssnr.rs` 拿 `budgets.max_pixels` 比一次就是），但那时它已经把图读完、
    // 把模型或 165 MB 的片段装好、上下文也建起来了。这条钉三层：判别在哪、判据是哪一个数、
    // 量不到时放行。只钉一层的话，把刀挪到别处、或者换成另一个上限，照样能过。
    const budget = read('../../src-tauri/src/compute/page_budget.rs');
    expect(budget, '要有一个只拿尺寸的类型').toContain('pub struct PagePixels {');
    expect(budget, '量尺寸只读头，不许把图解出来').toContain('with_guessed_format');
    expect(budget, '量不到就说量不到').toContain(
      'pub fn measure(path: &Path) -> Option<PagePixels>',
    );
    expect(budget, '判据只能是 worker 用的那一个数').toContain(
      'resource_policy::pixels_within_page_limit(self.width, self.height)',
    );
    expect(budget, '两边的边界要钉在同一处').toContain('8192×8192 恰好是这个上限本身');

    const manager = read('../../src-tauri/src/compute/manager.rs');
    const identityAt = manager.indexOf('if source.content_hash != content_hash {');
    const gateAt = manager.indexOf('super::page_budget::measure(&source.path)');
    const stageAt = manager.indexOf('crate::compute::inputs::stage(');
    expect(identityAt, '身份对账那一步还在').toBeGreaterThan(-1);
    expect(gateAt, '这一刀要在派发前就落下').toBeGreaterThan(-1);
    expect(stageAt, '输入要摆进输入根').toBeGreaterThan(-1);
    expect(gateAt, '先核身份再量尺寸：索引对不上时答的该是身份问题').toBeGreaterThan(identityAt);
    expect(gateAt, '量出来才谈摆不摆：装不下就别摆进输入根').toBeLessThan(stageAt);
    const gate = manager.slice(gateAt, stageAt);
    expect(gate, '错了要说成资源上限，界面才知道原图还在').toContain(
      'code: super::leases::RESOURCE_LIMIT_CODE,',
    );

    // 判据要能被跑起来验：真进程 IT 里两页对照（超限被拒、界内照算），外加身份优先那一条。
    const it = read('../../src-tauri/tests/compute_manager.rs');
    expect(it, '超限那一页要有一条真进程用例').toContain(
      'fn a_page_over_the_pixel_limit_is_refused_before_the_worker_is_asked()',
    );
    expect(it, '界内的对照不许省').toContain('上限之内的页不能被一起拦掉');
    expect(it, '身份优先于尺寸也要有话说').toContain(
      '同一张超限的图：索引对不上时答的是身份问题',
    );
  });

  it('hands the caches back once the compute process has been left alone for a while', () => {
    // §12.4 ④「idle30 秒释放模型/workspace」：用户切走两分钟，进程里那几十 MB 的权重和
    // NGX 的工作区不该一直挂着；而**收摊**（换进程）要等 120 秒。这条钉四层：数字、判据
    // 只有一处、两条钟的先后、以及「交回」在 worker 那边是不是真的把东西丢掉了。
    // 只钉一层的话，把交回接到别处、或者让它每 200 毫秒问一遍，照样能过。
    const policy = read('../../src-tauri/src/compute/resource_policy.rs');
    expect(policy, '§12.4 那个数字要钉住').toContain('pub const IDLE_RELEASE_MS: u64 = 30_000;');
    expect(policy, '两条钟共用一条含端点的判据，阈值由调用方给').toContain(
      'pub fn idle_due(idle_ms: u64, threshold_ms: u64) -> bool',
    );

    const manager = read('../../src-tauri/src/compute/manager.rs');
    expect(manager, '交回那条钟要是一个能配的阈值，不然测不到').toContain(
      'pub idle_release: Duration,',
    );
    expect(manager, '缺省就是策略里那个数').toContain(
      'idle_release: Duration::from_millis(IDLE_RELEASE_MS),',
    );
    const shutdownAt = manager.indexOf('self.shared.config.idle_shutdown.as_millis()');
    const releaseAt = manager.indexOf('self.shared.config.idle_release.as_millis()');
    expect(shutdownAt, '收摊那条钟还在看配置').toBeGreaterThan(-1);
    expect(releaseAt, '交回那条钟也在看配置').toBeGreaterThan(-1);
    expect(shutdownAt, '先问收摊、再问交回：反了交回就永远轮不到').toBeLessThan(releaseAt);
    expect(manager, '一段空闲只交一遍').toContain('} else if !self.idle_released');
    expect(manager, '闲置那两个字段只许有一处清').toContain('fn reset_idle(&mut self)');
    expect(
      manager.match(/self\.idle_since = None;/g)?.length ?? 0,
      '「起点」与「这一段交过没有」必须一起清，所以只能有 `reset_idle` 一处写它',
    ).toBe(1);
    expect(manager, '自动那条路只在真的发出去时记账').toContain(
      'if self.start_release_idle(None) {',
    );
    expect(manager, '一问一答：一帧在飞时不许再发第二帧').toContain(
      'session.release_pending = true;',
    );
    expect(manager, '自动交回也要能被数出来，不然没人证得了它发生过').toContain(
      'pub fn idle_releases(&self) -> u32',
    );

    // worker 那半：交回不能只是报个数，得真把会话丢回系统。
    const engine = read('../../src-tauri/worker/src/engine.rs');
    expect(engine, '引擎要能被要求交回模型缓存').toContain(
      'fn release_cached_models(&self) -> u32',
    );
    expect(engine, '不跑模型的引擎答 0 是一句实话').toContain('        0\n    }');
    expect(engine, '装箱之后必须转发，不然 Box<dyn Engine> 会悄悄答 0').toContain(
      '(**self).release_cached_models()',
    );
    const pipeline = read('../../src-tauri/worker/src/pipeline.rs');
    expect(pipeline, '两处缓存的数要加起来').toContain(
      'self.upscale.release_cached_session() + self.decensor.release_cached_engines()',
    );
    expect(pipeline, '空缓存答 0 与幂等也要有判据').toContain(
      'fn an_engine_with_nothing_cached_hands_back_zero_and_says_so_twice()',
    );
    const upscale = read('../../src-tauri/worker/src/upscale.rs');
    expect(upscale, '丢的是会话本身，不是「忘了它」').toContain(
      'u32::from(slot.take().is_some())',
    );
    const decensor = read('../../src-tauri/worker/src/decensor.rs');
    expect(decensor, '三个会话位都要交').toContain('for slot in [&self.bar, &self.mosaic]');
    const protocol = read('../../src-tauri/worker/src/protocol.rs');
    expect(protocol, '两半加起来才是宿主看到的数').toContain('let count = workspaces + models;');
    expect(protocol, '引擎要同时能被执行器和会话主线程用').toContain('let engine = Arc::new(engine);');

    // 判据要能被跑起来验：真进程 IT 里两段空闲各交一遍；真模型走一遍「跑过就还回去」。
    const it = read('../../src-tauri/tests/compute_manager.rs');
    expect(it, '闲置交回那条真进程用例要在').toContain(
      'fn a_worker_that_sits_idle_hands_its_workspaces_back_once_per_quiet_stretch()',
    );
    expect(it, '一段空闲只交一遍也要有话说').toContain('一段空闲里只该交一遍');
    expect(it, '第二段空闲还会交，这一条最容易漏').toContain('第二段空闲该再交一遍');
    const chain = read('../../src-tauri/tests/compute_model_chain.rs');
    expect(chain, '跑过的模型要真的还回去').toContain(
      'fn a_model_that_is_done_working_is_handed_back_where_nobody_needs_it()',
    );
  });

  it('measures a page soak with an instrument instead of a task manager screenshot', () => {
    // §12.4 ②③ 要的是「每页多少、峰值在哪、预热之后还涨不涨」，§12.5 点名要一个能跑的入口。
    // 这条钉住三件事：soak 真的量了（有仪器、有门槛、有分位），门槛照抄 §12.4 ② 自己的数，
    // 读数只有一处算（脚本从测试打出来的那一行读，不自己再算一遍——两处算同一件事早晚不一致）。
    const soak = read('../../src-tauri/tests/compute_soak.rs');
    expect(soak, 'soak 要单跑：分钟级、要独占真模型').toContain('#[ignore = "soak：');
    expect(soak, '量的是进程的私有提交与历史峰值').toContain(
      'counters.PrivateUsage as u64',
    );
    expect(soak, '峰值是「一页页读下来」的那个单调量').toContain(
      'counters.PeakPagefileUsage as u64',
    );
    expect(soak, '量不到就说量不到，不是 0').toContain('fn private_commit(pid: u32) -> Option<(u64, u64)>');
    expect(soak, '门槛照抄 §12.4 ②').toContain('const GROWTH_LIMIT: u64 = 32 * 1024 * 1024;');
    expect(soak, '当前值要跟平台比，不是只跟最后一页比').toContain(
      '.map(|row| row.worker_commit)\n        .max()',
    );
    expect(soak, '峰值这个单调量也要有话说').toContain('peak_growth < GROWTH_LIMIT');
    expect(soak, '页数多少决定分辨力，得能调').toContain('fn pages_to_run()');
    expect(soak, '分位要最近秩，样本少时插值会抹平最坏那一次').toContain(
      'fn percentile(values: &[u128], percent: u32) -> u128',
    );
    expect(soak, '交回的判据是份数：字节在这个尺寸的模型上被振荡淹掉').toContain(
      'handed_again >= 1,',
    );
    expect(soak, '收摊之后进程要真的没了').toContain('workerGoneAfterShutdown');
    expect(soak, '读数只打一行给脚本读').toContain('SOAK_JSON');

    const harness = read('../../.github/scripts/measure-compute-responsiveness.ps1');
    expect(harness, '§12.5 点名的入口就是这个文件名').toContain(
      "[ValidateSet('cpu', 'directml', 'dlssnr', 'all')]",
    );
    expect(harness, '读数从测试打的那一行读进来，不自己再算一遍').toContain(
      "$line.Substring('SOAK_JSON '.Length) | ConvertFrom-Json",
    );
    expect(harness, '量不到的要列出来，而不是假装量过').toContain('notMeasured = $notMeasured');
    expect(harness, '人读的那一份不许拿空表交差').toContain('soak 读数里页数对不上');
    expect(harness, '机器可读的那份要落盘').toContain('measure-$stamp.json');
    expect(harness, '人读的那份也要落盘').toContain('summary.md');
  });

  it('churns the worker twenty times and refuses an over-budget page without dying', () => {
    // §12.4 ⑥ 与 ③。这两条要证的都是**「不出现什么」**，所以判据必须点名每一样东西，
    // 不能靠「没报错」：孤儿进程要问进程表，staging 遗留要在一次**没有握手**的会话结束之后
    // 看目录，错误 cache 要逐文件哈希回文件名，重复终态要看事件流。大页那一档同理：
    // 挡住的判决得是那句 `resource_limit`，而且拒绝它的那个进程下一句还得答得上话。
    const storm = read('../../src-tauri/tests/compute_restart_storm.rs');
    expect(storm, '轮数是 §12.4 ⑥ 的原话').toContain('const ROUNDS: usize = 20;');
    expect(storm, '变异检查要有便宜的口子，但下限写在代码里、缺省仍是 20').toContain(
      'fn rounds() -> usize {',
    );
    expect(storm, '轮数下限写在代码里：少于 6 轮连熔断都点不亮').toContain(
      '.filter(|count| *count >= 6)',
    );
    expect(storm, '取消与强杀交替，两条路都要走到').toContain('let cancel_this_round = round % 2 == 0;');
    expect(storm, '熔断是这条路的一部分，不能绕开它假装没发生').toContain(
      'if matches!(manager.worker_status(), WorkerStatus::Broken { .. }) {',
    );
    expect(storm, '亮过熔断之后按界面的做法点重试，而不是等它自己好').toContain(
      'manager.retry_worker();',
    );
    expect(storm, '熔断一次都没亮过就说明这段路没走，那不算测过').toContain(
      'broken_rounds >= 1,',
    );
    expect(storm, '① 孤儿进程：退出码说了才算，句柄开着不算活着').toContain(
      'code == STILL_ACTIVE.0 as u32',
    );
    // 退出码挡不住进程号被复用：号一样、创建时间不一样，那是**另一个**进程。
    // （这条断言误报过一次：报出来的号几分钟后已经不存在了，也就是说当时问的是别人的号。）
    expect(storm, '① 孤儿进程要比身份，不能只比号').toContain(
      'fn worker_identity(pid: u32) -> Option<WorkerId> {',
    );
    expect(storm, '身份里要有创建时间').toContain(
      'GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)',
    );
    expect(storm, '号对上了、创建时间对不上就不算同一个进程').toContain(
      'if now.created != id.created {',
    );
    expect(storm, '存的是身份不是号').toContain('let mut interrupted: Vec<WorkerId> = Vec::new();');
    expect(storm, '只比号这条判据本身也要有一次单独的量').toContain(
      'fn a_recycled_process_id_is_not_the_same_process() {',
    );
    expect(storm, '② staging 遗留要钉在「会话结束之后不会再握手」的那一次上').toContain(
      'wait_until("收摊之后 staging 该收回去"',
    );
    expect(storm, '③ 错误 cache：文件名就是摘要，逐份哈希回去').toContain(
      'let stem = name.strip_suffix(".bin").unwrap_or(&name);',
    );
    expect(storm, '写到一半的临时件也不许留下').toContain('".part-"');
    expect(storm, '④ 重复终态：一件任务只许有一个结论').toContain(
      'let mut distinct: Vec<String> = states.iter().map(|state| format!("{state:?}")).collect();',
    );
    expect(storm, '终态之后再来的非终态事件也要抓').toContain(
      'if terminal_jobs.contains(&job_id) {',
    );
    expect(storm, '读同页必须是另一件任务，不是并进上一件').toContain(
      'again.job_id, submitted.job_id,',
    );
    // 这一条容忍的是「判完任务」与「记账/熔断」之间的那条缝（`end_session` 的顺序：先给
    // 任务结论，再重启记账）。容忍的边界要写清楚：只有「没有一个 Ready 的 worker 能接活」
    // 才算这种现场；状态是 Ready 就说明这一代还活着，那时再被判 UNAVAILABLE 别的原因，
    // 照旧红。熔断本身的严格语义由另一条用例（`a_tripped_breaker_judges_...`）钉着。
    expect(storm, '容忍的只有「这一代接不了活」这一种现场').toContain(
      'let no_worker_can_take_it = !matches!(manager.worker_status(), WorkerStatus::Ready { .. });',
    );
    expect(storm, '缝里被当场判掉几次要说出来，不能悄悄吞掉').toContain(
      '其中 {judged_in_the_gap} 次是「读同页」撞上那条缝被当场判掉的',
    );
    const manager = read('../../src-tauri/src/compute/manager.rs');
    // 判掉一件排队的活，状态就得跟它说同一件事：界面是照状态决定要不要给「重试」的。
    expect(manager, '熔断判活与状态必须同一个说法').toContain(
      'if let Some(reason) = self.broken.clone() {',
    );

    const large = read('../../src-tauri/tests/compute_soak.rs');
    expect(large, '§12.4 ③ 的三档尺寸').toContain(
      'const LARGE_TIERS: [(u32, u32); 3] = [(2_500, 2_000), (3_650, 2_740), (6_100, 4_100)];',
    );
    expect(large, '源上限是预算门自己算出来的，不是另抄一个数').toContain(
      'let allowed_source = PAGE_PIXEL_LIMIT / u64::from(SCALE).pow(2);',
    );
    expect(large, '被挡住的那一档，判决只能是预算门那个码').toContain(
      'code, RESOURCE_LIMIT_CODE,',
    );
    expect(large, '拒了一页之后这一代 worker 还得在').toContain(
      '大页被拒不该把这一代 worker 换掉',
    );
    expect(large, '100 页是 §12.4 ③ 的原话，可调但不许悄悄改小').toContain(
      'fn large_pages_to_run() -> u32 {',
    );
    expect(large, '真算的那两档要按尺寸分开比，横着比会得出假的红').toContain(
      'row.verdict == "Completed" && row.width == tier.0 && row.height == tier.1',
    );
    expect(large, '量不到的层数要写明白为什么量不到').toContain(
      '协议里的 layers 没有代码读；§12.4 的 1/3/5 层对应 DLSSNR 的 settings.passes，只有真 NGX + GPU 那条路跑得到',
    );

    const trio = read('../../scripts/compute/verify-round.ps1');
    expect(trio, '20 轮那条要进三连，不能只在手工跑里活着').toContain(
      'Step "restart-it" { cargo test --manifest-path $manifest --test compute_restart_storm -- --nocapture --test-threads=1 }',
    );
    expect(trio, '证据是它自己打的那一行：只看 1 passed 会漏掉熔断走没走').toContain(
      '"manager-it", "restart-it", "center-it"',
    );

    const harness = read('../../.github/scripts/measure-compute-responsiveness.ps1');
    expect(harness, '大页档由入口按需加跑，不是每跑一次都拖着').toContain('[int] $LargePages = 0');
  });

  it('refuses a page the scale cannot afford before the worker sees it, and times the queue the interface waits on', () => {
    const policy = read('../../src-tauri/src/compute/resource_policy.rs');
    expect(policy, '同一笔预算有两端：源图自己，与乘上倍率之后').toContain(
      'pub fn output_pixels_within_budget(source_pixels: u64, scale: u32) -> bool {',
    );
    expect(policy, '溢出取饱和：坏倍率不许溢出成一个小数字溜过去').toContain(
      'source_pixels.saturating_mul(factor.saturating_mul(factor))',
    );
    expect(policy, '链是一阶一阶接的，两阶 x2 是 x16 而不是 x4').toContain(
      'pub fn chain_output_pixels(source_pixels: u64, scales: &[u32]) -> u64 {',
    );

    const manager = read('../../src-tauri/src/compute/manager.rs');
    expect(manager, '派发前要把流水线的倍率乘一遍').toContain(
      'resource_policy::chain_output_pixels(pixels.count(), &scales)',
    );
    expect(manager, '判决用的是 worker 那一个上限，不是宿主新立的一个').toContain(
      'if projected > resource_policy::PAGE_PIXEL_LIMIT {',
    );
    expect(manager, '说清楚被拒的是哪一页、倍率乘出来多少').toContain(
      '这条流水线（倍率 {}）算出来是 {} 像素，超过一档 {} 像素的预算',
    );

    const it = read('../../src-tauri/tests/compute_manager.rs');
    expect(it, '一页自己装得下、乘上倍率装不下的那一格').toContain(
      'fn a_page_that_fits_alone_is_refused_once_the_scale_is_applied() {',
    );
    expect(it, '「派发前」要有观察量：被拒的页不许进输入根').toContain(
      '被拒的那一页不该被摆进输入根：派发前拒的意思就是 worker 连源图的字节都没见过',
    );

    const scheduler = read('../../src-tauri/src/compute/scheduler.rs');
    expect(scheduler, '§12.3 第一条那个界要写进断言').toContain('p95 <= 100_000,');
    expect(scheduler, '空表交不了差：每轮几次取样要写死').toContain('200 * 6,');

    const soak = read('../../src-tauri/tests/compute_soak.rs');
    expect(soak, '分块只在仪器上是个旋钮，产品路径仍然是 None').toContain('tile: soak_tile(),');
    expect(soak, '量出来的块大小要连着「缺省是哪儿来的」一起说').toContain(
      '产品路径上 stage.tile 一直是 None，worker 于是用核心的 DEFAULT_TILE_SIZE=128',
    );

    const trio = read('../../scripts/compute/verify-round.ps1');
    expect(trio, '队列那个读数要进三连，而且必须 --nocapture').toContain(
      'Step "queue-ack" { cargo test --manifest-path $manifest --lib -- --exact --nocapture --test-threads=1 compute::scheduler::tests::the_acks_the_interface_waits_for_stay_under_the_ui_threshold }',
    );
    expect(trio, '第 20 步的日志也要进证据表').toContain('"check-ws", "queue-ack"');
  });

  it('runs a real GPU tier and a layer sweep through the one entry point, and says which VRAM column is readable', () => {
    const harness = read('../../.github/scripts/measure-compute-responsiveness.ps1');
    expect(harness, '真 GPU 档要有开关，缺省不跑').toContain('[switch] $GpuSoak,');
    expect(
      harness,
      '层数收成字符串自己切：-File 那一侧的逗号会被吞掉，收成 [int[]] 会把不存在的档跑成绿的',
    ).toContain("[string] $Layers = '',");
    expect(harness, '层数给得不对要当场报错').toContain('层数给得不对（只认 1..8）');
    expect(harness, '整卡用量那一栏要真的去问厂商工具').toContain(
      '$row = & nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>$null',
    );
    expect(harness, 'DXGI 那半栏读不出数这件事要写进脚本，而不是把 0 当成没占显存').toContain(
      'DXGI 的 CurrentUsage 在本机恒为 0',
    );
    expect(harness, 'GPU 档要跑的是那一条用例，不是整个文件').toContain(
      '--exact a_directml_page_soak_runs_on_the_gpu_and_keeps_its_vram_bounded',
    );
    expect(harness, '层数那一档跑的也是那一条用例').toContain(
      '--exact --nocapture dlssnr::tests::repeated_pages_keep_private_commit_bounded_and_release_workspaces',
    );
    expect(harness, '层数的读数只认测试自己打的那一行').toContain("'DLSSNR private commit: passes=*'");
    expect(harness, '读数认不出来要报错，不许填个估计值').toContain(
      "'passes=(\\d+) warm=(\\d+) MiB, after32=(\\d+) MiB, released=(\\d+) MiB'",
    );
    expect(harness, '没打出读数就不许放行，而且守的是那个条件').toContain(
      'if (-not $line) { throw "GPU 档没打出 GPU_SOAK_JSON（exit=$code），读 $log" }',
    );
    expect(harness, '打了 -GpuSoak 却什么都没跑，出口不许是绿的').toContain(
      '要了 GPU 档（-GpuSoak）却没跑：soak-gpu 那一段没留下读数',
    );

    const soak = read('../../src-tauri/tests/compute_soak.rs');
    expect(soak, 'GPU 档要问的是「要显卡」，不是「随便挑一个后端」').toContain('EnginePolicy::Gpu');
    expect(soak, '政策报成了 cpu 就说明这一跑问的根本不是显卡').toContain(
      '第 {index} 页该是显卡干的活（政策报成了 cpu 就说明这一跑问的根本不是显卡）：{record:?}',
    );
    expect(soak, '点名要显卡之后悄悄退回去也是红的').toContain('点名要显卡之后不该悄悄退回去：{:?}');
    expect(soak, '显存那一栏读得出就读，读不出不许编').toContain('adapter_used: adapter.as_ref().map(|memory| memory.used),');
    expect(soak, '清单里的后端口径由参数给，不再写死').toContain(
      'fn install_model_with(',
    );
    expect(soak, '后端口径是这个参数说了算').toContain('backends: &[&str],');
    expect(soak, '本地夹具读不到要跳过，而且说清跳过的是哪一份').toContain(
      '跳过：读不到 {}（{error}）',
    );

    const core = read('../../src-tauri/crates/compute-core/src/dlssnr/mod.rs');
    expect(core, '层数旋钮只认环境变量，缺省仍是写照的那个数').toContain('YOMIKA_DLSSNR_PASSES');
    expect(core, '层数被 normalized() 改过就不是这一跑问的那个数').toContain(
      '层数被 normalized() 改过就不是这一跑问的那个数了',
    );
    expect(core, '打印行要带上层数，否则量完不知道问的是哪一档').toContain(
      'DLSSNR private commit: passes={passes} warm={} MiB',
    );
  });

  it('drives a real window through the browser input pipeline and keeps the renderer in the memory column', () => {
    const driver = read('../../.github/scripts/compute-ui-probe.mjs');
    expect(driver, '档案库的行是「选中」不是「跳转」，所以地址不能靠点一行来猜').toContain(
      '行是 `button.archive-row`，点它是「选中」不是「跳转」',
    );
    expect(driver, '挑档案用的是应用自己的仓储，不是猜出来的一串数字').toContain(
      "await import('/src/repositories/nativeLibraryRepository.ts')",
    );
    expect(driver, '挑第一条并把它的身份交出来').toContain(
      'const page = await repository.listArchivesPage(server.id, 0, 1);',
    );
    expect(driver, '阅读器地址由身份拼出来，`?server=` 用 scopeId').toContain(
      'readerUrl = `${discovered.origin}/reader/${discovered.archiveId}?server=${discovered.server}`;',
    );
    expect(driver, '输入去重会把样本吃掉：第一次跑派 120 条只记到 100 条').toContain(
      '每一条输入都自己排一对 rAF',
    );
    expect(driver, '派的是浏览器输入管线上的事件，不是 element.click()').toContain(
      "await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode:",
    );
    expect(driver, '读数只走这一行，脚本那一侧不重算').toContain(
      "console.log('UI_PROBE_JSON ' + JSON.stringify(report));",
    );
    expect(driver, '杀 worker 那一档要量「2 秒内给状态」这条门槛本身').toContain(
      'withinBudget: Boolean(signalled && signalled.ms >= 0 && signalled.ms <= 2000),',
    );
    expect(driver, '杀完还要证明 UI 仍然答输入，否则「仍可操作」只是句话').toContain(
      'inputAnswered: after > before,',
    );

    const harness = read('../../.github/scripts/measure-compute-responsiveness.ps1');
    expect(harness, '真窗口那一档是个开关，不是默认跑的').toContain('[switch] $UiProbe,');
    expect(harness, '一个进程里两个 WebView2 环境，两个地址都得问').toContain(
      "foreach ($host_ in @('127.0.0.1', '[::1]')) {",
    );
    expect(harness, '127.0.0.1 那一侧出的是托盘菜单页，不是主窗').toContain(
      "if ($entry.url -like '*tray-menu*') { continue }",
    );
    expect(harness, '本机连 localhost 会挂死，探活用 curl.exe').toContain(
      '& curl.exe -sS --max-time 5 "http://$host_`:$Port/json/list"',
    );
    expect(harness, '守的是那个条件，不是那句话：少一条样本就当场红').toContain(
      'if (-not $reading.inputs -or [int]$reading.inputs.total -lt $UiInputs) {',
    );
    expect(harness, '帧样本不够也是红，守的同样是条件本身').toContain(
      'if (-not $reading.frames -or [int]$reading.frames.count -lt 100) { throw "UI 档（$name）的帧样本太少：$log" }',
    );
    expect(harness, '§12.4 ⑤ 的 renderer 那一栏真的去采了').toContain('rendererMib = Get-RendererCommitMib');
    expect(harness, 'renderer 那一栏的重复计数限制写在读数里，不假装它干净').toContain(
      'renderer 是所有 msedgewebview2 进程私有字节之和（两个 WebView2 环境都在内，共享页重复计数）',
    );
    expect(harness, '杀了 worker 却没量到 UI 还答不答输入，这一跑不许算过').toContain(
      'if (-not $kill -or -not $kill.inputAnswered) { throw "杀了 worker 却没量到 UI 还答不答输入：读 $($killReading.readerUrl)，读数在 ui-probe-*.log" }',
    );
    expect(harness, 'md 里的样本数对不上也要拦，报告不许比读数大').toContain(
      'throw "UI 档读数里输入样本对不上：$(($reading.inputs.total)) 条 vs 要 $UiInputs 条（md 不能拿空表交差）"',
    );
  });

  it('runs the same input twice, once idle and once while the machine is busy, and reads the restart off the screen', () => {
    const driver = read('../../.github/scripts/compute-ui-probe.mjs');
    const harness = read('../../.github/scripts/measure-compute-responsiveness.ps1');
    const manager = read('../../src-tauri/src/compute/manager.rs');
    const app = read('../../src/app/App.tsx');

    // ① 「重载」压的是应用自己那条路：同一个仓储、同一份载荷形状，不另造一份负载。
    expect(driver, '压机器要压真活：走阅读器提交任务用的那个仓储').toContain(
      "await import('/src/repositories/nativeComputeRepository.ts')",
    );
    expect(driver, '提交的就是阅读器那一份载荷（后台优先级，别抢用户当前那一页）').toContain(
      "priority: 'background',",
    );
    expect(driver, '压机器之前也要问出档案身份：即使 --reader-url 是点名给的（纯另一条来路上只有它知道）').toContain(
      "if (readerUrl === 'auto' || loadPages > 0) discovered = await discoverArchive();",
    );
    expect(driver, '空载那一趟必须真空：超分/去码开着的话，比的就是「本来就有的负载」').toContain(
      "const saved = await repository.save({ ...snapshot, upscaleBackend: 'off', upscaleAutoEnable: false, decensorModel: '' });",
    );
    expect(driver, '等 worker 起来要连 stopped 一起等：只看 starting 会在进程还没起时放行，把真话读成从没起来').toContain(
      "workerNow.kind === 'starting' || workerNow.kind === 'stopped'",
    );
    expect(driver, '要杀的那一代由应用自己回答，harness 不去猜进程号').toContain(
      'if (!status || !status.peerPid) throw new Error(',
    );

    // ② 界面状态那一栏量的是**那条状态本身**，不是满页找词。
    expect(driver, '量的是状态条自己（满页找「正在恢复」在阅读器里一定碰得上，量到什么都不证明）').toContain(
      'const found = document.querySelector(\'[data-testid="compute-worker-status"]\');',
    );
    expect(driver, '找词那一版必须已经不在').not.toContain("const words = ['正在恢复'");
    expect(driver, '状态条上的那两个属性就是读数').toContain("state: found.getAttribute('data-worker-state'),");
    const toast = read('../../src/components/Toast.tsx');
    expect(toast, 'toast 卡片要把 testId 与属性铺到 DOM 上，仪器才有得量').toContain(
      'data-testid={item.testId} {...item.attributes}',
    );
    const bridge = read('../../src/components/ComputeWorkerToasts.tsx');
    expect(bridge, '状态是转成 toast 报的（常驻提示条已经删掉：它与 toast 说同一件事，且落进 broken 就再也撤不掉）').toContain(
      "testId: 'compute-worker-status',",
    );
    expect(bridge, '这条状态把「state」摆在 DOM 上，仪器才有得量').toContain(
      "'data-worker-state': notice.state",
    );
    expect(bridge, '只有这一代真起来过、且宿主说它正在起，才叫「正在恢复」；stopped 是常态（没有要跑的活就没有 worker），不许读成恢复').toContain(
      "if (status.kind === 'starting' && seenReadyEpoch >= 0) {",
    );
    expect(bridge, '宿主每轮重播同一个状态，只说一次：重复的那一轮靠 key 折掉，不叠第二张').toContain(
      'if (notice.key === lastKey) return;',
    );
    expect(app, '这条状态挂在全应用上：挂在某条路由里，从阅读器退出来就看不见了').toContain('<ComputeWorkerToasts />');
    expect(
      () => read('../../src/components/ComputeWorkerNotice.tsx'),
      '旧那条常驻提示条必须已经不在了：它与 toast 说同一件事，而它一旦落进 broken 就再也没人撤掉（宿主每轮重播同一个 broken），屏幕上是永远下不去的一句话',
    ).toThrow();

    // ③ 桥那头解不出来的那次真缺陷：serde 的 rename_all 只管变体名，字段要 rename_all_fields。
    expect(manager, '字段名也要 camelCase，不然 compute_worker_status 的响应永远解不出来').toContain(
      '#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]',
    );
    expect(manager, '这条真缺陷得有自己那条用例守着').toContain(
      'fn the_worker_status_crosses_the_bridge_with_the_field_names_the_schema_wants()',
    );

    // ④ 入口脚本：两趟、门槛、以及「这一栏超了必须红」。
    expect(harness, '两趟对照是这一档自己的开关').toContain('[switch] $DropFrames,');
    expect(harness, '压多少件写在参数上，不当常数藏在代码里').toContain('[int] $UiLoadPages = 24,');
    expect(harness, '两趟走的是同一段代码，不是两份').toContain(
      'function Invoke-UiProbePass([string] $name, [int] $LoadPages, [int] $KillPid) {',
    );
    expect(harness, '「压了机器」要有别人证：一件都没提交就不算压过').toContain(
      'throw "压机器那一趟没交出读数（load 是空的或一件都没提交）：读 $($loadedPass.log)"',
    );
    expect(harness, '守的是那个条件本身（把条件换成 $false，只剩消息就拦不住了）').toContain(
      'if (-not $loaded.load -or [int]$loaded.load.submitted -lt 1) {',
    );
    expect(harness, 'worker 从没起来也一样要拦，且守的同样是条件').toContain(
      "if (-not $loaded.load.worker -or $loaded.load.worker.kind -eq 'stopped') {",
    );
    expect(harness, '提交了任务可这一代 worker 从没起来，那比的不是重载').toContain('可这一代 worker 从没起来过');
    // 门槛那一句要连行尾一起钉：`budgetPp = 5` 这个字面量在 `budgetPp = 50` 里也成立
    // （变异检查第一次就是这么放过 F 的），加上换行才真的钉住「这个数就是 5」。
    expect(harness, '门槛是 §12.3 那个数，改动它就得改这句').toContain('budgetPp = 5\n');
    expect(harness, '判的是「增加不超过 5 个百分点」').toContain('withinBudget = ($deltaPp -le 5)');
    expect(harness, 'md 里的两趟样本数要对得上').toContain(
      'throw "重载对照的两趟帧样本有一趟太少：$($delta.idleFrames) / $($delta.loadedFrames)"',
    );
    expect(harness, '超门槛要红：§12.3 要求明确降级，不许当成通过').toContain(
      "if ($uiResult.framesDelta -and -not $uiResult.framesDelta.withinBudget) { $red += 'frames-delta' }",
    );
    // ⑤ §12.4 ⑤ 的总内存要在机器真被压着的时候采：空载那趟采的时候 worker 那一栏还是空的。
    expect(harness, '重载时的四栏总内存是采样峰值，不是事后估').toContain(
      '$sampler = Start-Job -ArgumentList $samplerLog -ScriptBlock {',
    );
    expect(harness, '峰值要进读数，md 才画得出那一行').toContain("memoryUnderLoad = $loadMemory");
    // ⑥ 掉帧比例不能在驱动里就修约：两趟相减要分辨 5 个百分点，量化成整百分点就永远读出 0。
    expect(driver, '掉帧比例给不修约的分式（§12.3 的门槛是 5 个百分点，两位小数够不着）').toContain(
      'droppedRatio: frames.length ? dropped.length / frames.length : null,',
    );
    expect(driver, '修约过的那一版必须已经不在').not.toContain('droppedRatio: frames.length ? round(');
  });

  it('pairs only a worker from the same build, and says so instead of restarting it three times', () => {
    const messages = read('../../src-tauri/crates/compute-protocol/src/messages.rs');
    const manager = read('../../src-tauri/src/compute/manager.rs');
    const workerBuild = read('../../src-tauri/worker/build.rs');
    const workerLib = read('../../src-tauri/worker/src/lib.rs');
    const workerMain = read('../../src-tauri/worker/src/main.rs');
    const hostBuild = read('../../src-tauri/build.rs');
    const workerScript = read('../../.github/scripts/build-compute-worker.ps1');
    const windowsScript = read('../../.github/scripts/build-windows.ps1');
    const managerIt = read('../../src-tauri/tests/compute_manager.rs');

    // ① 协议：大版本不符要能单独问出来（它与「帧坏了」在宿主那边是两种处置）；构建戳是
    // **后加的字段**，老 worker 的 hello 里没有这一栏，不许因此解不出来。
    expect(messages, '外来的大版本与「帧坏了」处置不同，判断得能单独问').toContain(
      'pub fn is_version_mismatch(&self) -> bool {',
    );
    expect(messages, '判的就是那一个变体').toContain('matches!(self, Self::UnknownVersion { .. })');
    expect(messages, '老 worker 不报这一栏也得能解出来').toContain(
      '    #[serde(default)]\n    pub commit: String,',
    );

    // ② 宿主：戳编进主 exe（集成测试是独立 crate，env! 在那里取不到，必须是 lib 里的常量）；
    // 一致才拼，不一致就拒跑——不是崩溃，不进那本 60 秒 3 次的账。
    expect(manager, '戳要编进主 exe，且集成测试拿得到').toContain(
      'pub const HOST_BUILD_COMMIT: &str = env!("YOMIKA_BUILD_COMMIT");',
    );
    expect(manager, '三格：一样 / 宿主自己没戳 / 对不上').toContain('pub enum StampVerdict {');
    expect(manager, '判戳是一件能单独钉住的事').toContain(
      'pub fn build_stamp_verdict(host: &str, worker: &str) -> StampVerdict {',
    );
    expect(manager, '必须在回 ack 之前判：回了 ack 就是认下了这一代').toContain(
      'match build_stamp_verdict(&self.shared.config.host_build_commit, &hello.build.commit)',
    );
    expect(manager, '拒跑不走 restart：换一代解决不了「它是另一份构建」').toContain(
      'fn refuse_session(&mut self, reason: &str) {',
    );
    expect(manager, '拒跑之后要落 Broken，并且不再让任务排队等').toContain(
      'state.scheduler.fail_queued(WORKER_UNAVAILABLE_CODE, now_ms);',
    );
    expect(manager, '大版本不符走拒跑，帧坏了才走「对端出事」').toContain(
      'fn parse_failure_report(error: &yomika_compute_protocol::ProtocolError) -> Report {',
    );
    expect(manager, '读线程那条路用的是这个判断').toContain(
      'let _ = sender.send(parse_failure_report(&error));',
    );
    expect(manager, '宿主那一栏要能由测试扮演（集成测试得造得出「两半不是一对」）').toContain(
      'pub host_build_commit: String,',
    );
    expect(managerIt, '这一条得在真进程里跑到：提交 → 拒跑 → 状态不自己变').toContain(
      'fn a_worker_from_another_build_is_refused_instead_of_retried_as_a_crash()',
    );

    // ③ worker：同一个环境变量、同一段缺省取 git 的逻辑，两半才天然同戳。
    expect(workerBuild, 'worker 原来一个 build.rs 都没有').toContain(
      'cargo:rustc-env=YOMIKA_BUILD_COMMIT=',
    );
    expect(workerBuild, '缺省与主 exe 那一份同源：都从 git 取').toContain(
      '["rev-parse", "--short=12", "HEAD"]',
    );
    expect(hostBuild, '主 exe 那一份也还在（同一条命令，不是两份规矩）').toContain(
      '--short=12',
    );
    expect(workerMain, '握手里报的戳引的是那个常量，不是另写一份').toContain(
      'commit: yomika_compute_worker::BUILD_COMMIT.to_string(),',
    );
    // 这一串必须**真的躺在 release 的 .rdata 里**：`to_string()` 会被 LLVM 折成寄存器
    // 立即数，于是按字节找永远找不到——这一轮的红就是这么来的（debug 构建不折，所以
    // 这个洞只在交付构建上露头）。
    expect(workerLib, '这一串得有字节形态躺在文件里，打包核查才核得了戳').toContain(
      'pub static YOMIKA_BUILD_COMMIT_STAMP: [u8; BUILD_COMMIT.len()] = build_commit_bytes();',
    );
    expect(workerLib, '`#[used]` + `#[no_mangle]` 才扛得住 /OPT:REF 与优化折叠').toContain(
      '#[used]\n#[no_mangle]',
    );
    expect(workerLib, '字节形态不许另抄一份字面量，长度取自同一个常量').toContain(
      'const fn build_commit_bytes() -> [u8; BUILD_COMMIT.len()] {',
    );

    // ④ 打包：先把 worker 编出来，再把它的字节**嵌进主 exe**——交付只有一个可执行
    // 文件，跑起来仍是两个进程（2026-10-09，`docs/141`）。原来没有人编 worker；
    // 后来编了但只是摆在旁边（第二个文件）；现在是嵌进去。
    expect(workerScript, 'worker 的构建脚本要自己验一遍戳').toContain(
      '& (Join-Path $PSScriptRoot "verify-build-stamp.ps1") -Path $final',
    );
    expect(workerScript, '产物一律进 src-tauri\\target：开发环境的 CARGO_TARGET_DIR 不许改交付物').toContain(
      '"--target-dir", $targetDir,',
    );
    expect(workerScript, 'ORT 是静态链的：目录里冒出运行库就说明包法变了').toContain(
      "throw \"交付目录里出现了不该有的运行库（ORT 是静态链的）：$($strays.Name -join ', ')\"",
    );
    expect(workerScript, '参数不能叫 -Debug：CmdletBinding 自带那个通用参数，重名则一行都跑不到').not.toContain(
      '[switch]$Debug,',
    );
    expect(windowsScript, 'Windows 打包必须顺手编出 worker 并…').toContain(
      '& (Join-Path $PSScriptRoot "build-compute-worker.ps1") @workerArgs',
    );
    // 嵌哪一份、嵌不嵌，都是**显式输入**：`build.rs` 照这两个变量去读字节，读不到就
    // 当场让构建失败（悄悄用上一次那一份，等于把两半的戳错开）。
    expect(windowsScript, '嵌进去的那一份要显式指给 build.rs').toContain("$env:YOMIKA_WORKER_BINARY = $workerBinary");
    expect(windowsScript, '嵌的开关也要显式打开').toContain("$env:YOMIKA_EMBED_WORKER = '1'");
    const workerBuildAt = windowsScript.indexOf('build-compute-worker.ps1');
    const hostBuildAt = windowsScript.indexOf('"run", "tauri", "build"');
    expect(
      workerBuildAt >= 0 && hostBuildAt >= 0 && workerBuildAt < hostBuildAt,
      'worker 必须先编：顺序反了，嵌进去的就是上一次那一份（worker ' +
        workerBuildAt +
        ' / 宿主 ' +
        hostBuildAt +
        '）',
    ).toBe(true);
    expect(windowsScript, '编完的宿主自己要能被读出载荷，读不出就不是单文件产物').toContain(
      '主 exe 里那份 worker 载荷读不出来',
    );

    // ⑤ 字节形态：载荷躺在文件中间，所以读写两侧对「记号」的长度必须一个字节不差。
    const buildScript = read('../../src-tauri/build.rs');
    const payloadModule = read('../../src-tauri/src/compute/worker_binary.rs');
    expect(buildScript, '不嵌的时候写一份空载荷：日常 cargo test 不该把 24 MB 塞进每个测试二进制').toContain(
      'const GENERATED_WITHOUT_WORKER',
    );
    expect(buildScript, '开着开关却找不到 worker 就当场失败，不许悄悄编出一个没有 worker 的宿主').toContain(
      'YOMIKA_EMBED_WORKER 开着，却找不到 worker 可执行文件',
    );
    expect(buildScript, '宿主里那份载荷是压过的：否则 `no-host-ort` 那两条字节判据会红在自己的产物上').toContain(
      'fn pack_worker_payload(',
    );
    expect(payloadModule, '记号是 21 个字母加一个 0x01，长度取常量而不是另抄一个数').toContain(
      "const MAGIC: &[u8] = b\"YOMIKA-WORKER-PAYLOAD\\x01\";",
    );
    expect(payloadModule, '主程序旁边写得进去就写旁边，写不进去退到数据目录').toContain(
      'pub fn ensure(beside: &Path, fallback_dir: &Path, payload: Option<&[u8]>) -> PathBuf',
    );
    expect(payloadModule, '上一代那一份要收走：24 MB 一份，升级几次就是几百兆').toContain('fn forget_older(');
    expect(payloadModule, '写旁边失败就退到数据目录，两处都得试').toContain(
      'if !fallback_dir.as_os_str().is_empty() && fallback_dir != beside.parent().unwrap_or(Path::new("")) {',
    );
    expect(payloadModule, '落点名字就是摘要：一份坏了也不会与上一代串味').toContain(
      'let name = format!("{stem}-{}{extension}", short_hex(&digest));',
    );
    // 三份拷贝里，PowerShell 这一份是自检与清单、冷启动共用的那个读端。它的头偏移必须
    // 由记号长度推出来：抄一个 21 进去就会把正文读成垃圾（2026-10-09 实测
    // `packedLength=2,080,094,465`，而 `+22` 才对）。
    const payloadReader = read('../../.github/scripts/worker-payload.ps1');
    expect(payloadReader, '记号的长度取常量，不另抄一个数').toContain('$head = $at + $script:PayloadMagic.Length');
    expect(payloadReader, '解出来的字节要与载荷头里的摘要逐字节比').toContain(
      '解出来的字节与载荷头里的摘要对不上',
    );
  });

  it('inspects the package the way a user meets it, and never calls a link a runtime', () => {
    const pkg = read('../../.github/scripts/verify-compute-package.ps1');

    // ① 只读 + 白名单：源目录旁边是用户的活库与几 GB 缓存，多拷一个字节都算破坏。
    expect(pkg, '要写就写到 -Stage 给的目录里，源目录一个字节都不许动').toContain(
      '$stageFull = (Resolve-Path -LiteralPath $Stage).Path',
    );
    expect(pkg, '进包的是枚举白名单，不是「整个目录去掉几个」').toContain(
      "foreach ($name in @('yomika.exe', 'DirectML.dll')) {",
    );
    // 交付只有一个可执行文件：包面再冒出一份 worker，是「单文件」这句话被破了，
    // 不是「多一份保险」（2026-10-09，`docs/141`）。
    expect(pkg, '包面不许有第二份 worker 可执行文件').toContain("Note 'no-separate-worker'");
    expect(pkg, 'worker 的字节要从主 exe 里解出来才算数').toContain(
      '$reading = Read-WorkerPayload -HostExe $hostExe',
    );
    expect(pkg, '解出来之后还要单独验它带的构建戳').toContain("Note 'worker-payload-stamp'");
    // 8-h⑤ 的教训：守卫软跳过时「绿」什么都不算——载荷缺失时那两条查 worker 字节的
    // 判据必须留下名字并记假，报告里少两行比多两行红更容易被读成「这一项过了」。
    expect(pkg, 'worker 的字节没解出来时，那两条字节判据也要记假而不是消失').toContain(
      "Note 'worker-has-ngx' $false 'worker 的字节没解出来，查不了'",
    );
    expect(pkg, '包面无缘无故少一条判据是查不到的：主 exe 不在时载荷那两条也记假').toContain(
      "Note 'worker-payload' $false '包里没有主 exe，无从谈载荷'",
    );

    // ② 查的是包面事实：这个包最终要去一台没装 CUDA、没装 Vulkan、甚至没有 N 卡的机器
    // 上跑，本机跑得动证明不了那件事。
    expect(pkg, 'Latin-1 直扫字节，跟构建戳校验同一招').toContain(
      '$text = [System.Text.Encoding]::GetEncoding(28591).GetString($Bytes)',
    );
    expect(pkg, '找的是字节里的字面量，而且针要先编成 UTF-8（中文才找得到）').toContain(
      '$pattern = [System.Text.Encoding]::GetEncoding(28591).GetString([System.Text.Encoding]::UTF8.GetBytes($needle))',
    );
    expect(pkg, '按序比较，别让文化设置插手').toContain(
      '$text.IndexOf($pattern, [System.StringComparison]::Ordinal) -ge 0',
    );

    // ③ 宿主那一半：垫片与 ORT 的痕迹一个都不许在。
    expect(pkg, '宿主的垫片导出名不许在').toContain(
      "$found = Find-Literals $hostBytes @('yomika_ngx_init')",
    );
    expect(pkg, '宿主 ORT 那一半就看这三个名字').toContain(
      "$found = Find-Literals $hostBytes @('d3d12.dll', 'DirectML.dll', 'onnxruntime')",
    );
    // 这一句是判据被自己的误报教出来的：`ort-api` 是协议常量，宿主拿它当缓存身份，
    // 它本来就该在宿主的字节里。查它会红在一件设计上就该如此的事。
    expect(pkg, '运行库标签是协议常量，宿主本来就带着它：拿它当「链了 ORT」的证据会误报').toContain(
      '**不查 `ort-api`**',
    );

    // ④ worker 那一半要的正好相反：引擎在它这一侧，标签还得是协议里那一份。
    expect(pkg, 'worker 里必须有垫片的导出名').toContain(
      "$found = Find-Literals $workerBytes @('yomika_ngx_init')",
    );
    expect(pkg, '运行库标签是问协议源码要的，不是另抄一份字面量').toContain(
      "$labelMatch = [regex]::Match($protocolSource, 'WORKER_RUNTIME_LABEL:\\s*&str\\s*=\\s*\"([^\"]+)\"')",
    );

    // ⑤ 运行库必须是真文件：`ort` 的 copy-dylibs 会留一个指向开发机缓存的链接，
    // 那东西拷到别的机器上就断。
    expect(pkg, '不认符号链接，也不认占位的小文件').toContain(
      '$ok = (-not $isLink) -and ($item.Length -gt 1MB)',
    );
    expect(pkg, 'reparse point 查全树，不只查那几个文件').toContain(
      '$links = @($packageFiles | Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 })',
    );

    // ⑥ 「装了才能跑」的东西一个都不许随包：CUDA 与 Vulkan 那两档还没接。
    expect(pkg, 'CUDA 运行库一个都不许随包').toContain(
      "$_ -like 'cudart*' -or $_ -like 'cublas*' -or $_ -like 'cudnn*' -or $_ -like 'nvrtc*' -or",
    );
    expect(pkg, 'Vulkan 运行库一个都不许随包').toContain(
      "$vulkan = @($names | Where-Object { $_ -like 'vulkan-1.dll' -or $_ -like 'nvoglv*' -or $_ -like 'vulkaninfo*' })",
    );
    expect(pkg, '垫片与片段都不随包：垫片运行期落进 data/，片段用户自备').toContain(
      "$shim = @($topNames | Where-Object { $_ -eq 'yomika_ngx.dll' -or $_ -eq 'nvngx_dlssnr.dll' })",
    );

    // ⑦ 随包模型与自己的清单对得上；干净语义只对没跑过的包成立。
    expect(pkg, '随包模型的哈希要跟清单一致').toContain(
      '$expected = (Get-Content -LiteralPath $modelManifest -Raw | ConvertFrom-Json).sha256.ToLowerInvariant()',
    );
    expect(pkg, '跑过的安装目录里 data/ 是用户的，这一条跳过别的照查').toContain(
      "Note 'clean-data' $true '这是跑过的安装目录（-Installed），data/ 里的用户东西不算问题'",
    );
    expect(pkg, '有 BAD 就 exit 1，不给「全绿」留口子').toContain('exit 1');
    // `@($list)` 套 `List[object]` 在 pwsh 7.6.6 上会抛 Argument types do not match。
    expect(pkg, '读数要先 ToArray()，否则 JSON 那一步自己就炸').toContain(
      'results   = $script:results.ToArray()',
    );

    // ⑧ 这台机器上没有可接的 CUDA/Vulkan 档，词汇表里也就不许有它们的名字。
    const runtime = read('../../src-tauri/crates/compute-core/src/runtime.rs');
    expect(runtime, '词汇表就这四个名字').toContain(
      'let shipped = [\n            RuntimeId::CoreMl.as_str(),\n            RuntimeId::Cpu.as_str(),\n            RuntimeId::DirectMl.as_str(),\n            RuntimeId::Nnapi.as_str(),\n        ];',
    );
    expect(runtime, '这一句是变异检查要认的那一句').toContain(
      '运行库词汇表只认这四个名字：多一个就说明产品里多了一条「装了才能跑」的运行库',
    );
    expect(runtime, '偏好里也不许冒出没接的运行库').toContain(
      '!matches!(name, "cuda" | "vulkan" | "ncnn-vulkan" | "ort-cuda")',
    );

    // ⑨ 无 worker 文件那一幕：当场给结论、不吃熔断账、补上文件点一次重试就能跑。
    const manager = read('../../src-tauri/tests/compute_manager.rs');
    expect(manager, '没有 worker 这一份时，必须在真人跑得到的进程里演一遍').toContain(
      'fn a_missing_worker_file_is_reported_at_once_and_does_not_block_the_window()',
    );
    expect(manager, '坏的是包，不是这台机器：把文件摆回去就该能跑').toContain(
      'std::fs::copy(worker_exe(), &missing)',
    );
    expect(manager, '这一档不吃熔断的重启账').toContain('!reason.contains("重启次数到顶")');

    // ⑩ 打包末尾要顺手自检一遍——自检没人跑，等于没有。
    const windowsBuild = read('../../.github/scripts/build-windows.ps1');
    expect(windowsBuild, '打包完之后要验一遍这个便携目录').toContain(
      '& pwsh -NoProfile -File (Join-Path $PSScriptRoot "verify-compute-package.ps1") -Stage $packageCheck',
    );
    expect(windowsBuild, '自检不过就让这一趟构建红掉，别把坏包当成功').toContain(
      'if ($LASTEXITCODE -ne 0) { throw "交付包自检没过（exit=$LASTEXITCODE）" }',
    );
    expect(windowsBuild, '`exit 1` 退的是整个会话：那个脚本必须单起一个进程调').toContain(
      '单起一个 pwsh：那个脚本用 `exit 1` 报不过',
    );
  });

  it('ships a package with no desktop half in it, and no door left without an answer', () => {
    // `docs/71:665`：Android 那一侧不许有 desktop 可执行依赖。2026-10-03 的 release 构建真的
    // 在这里红过：`compute-core` 的 `dlssnr` 是**目标门**（Windows），而宿主有两处跨平台代码
    // 无条件引它 —— `error[E0432]: unresolved import yomika_compute_core::dlssnr`（proxy.rs，
    // `--> crates\compute-core\src\lib.rs:44:9 ------- the item is gated here`）与
    // `error[E0433]: cannot find dlssnr in yomika_compute_core`（manager.rs 的显存读数）。
    // 收口的形状就是下面这几句。**只有 Android 构建能发现它们没了**，而它要 NDK、不在三连
    // 里，所以这里必须有钉子。
    const proxy = read('../../src-tauri/src/compute/proxy.rs');
    // 这几个文件的行尾不统一（proxy.rs 是 CRLF，manager.rs/dlssnr 是 LF），所以「属性在
    // 上一行、被门的东西在下一行」这种形状用 `\s+` 的正则钉，别把行尾也钉进去。
    expect(proxy, '这条桥只在 Windows 上引 DLSSNR 的设置').toMatch(
      /#\[cfg\(windows\)\]\s+use yomika_compute_core::dlssnr::DlssnrSettings;/,
    );
    expect(proxy, '授权名也跟着目标门').toMatch(/#\[cfg\(windows\)\]\s+const BYTE_DLSSNR_GRANT/);
    expect(proxy, 'DLSSNR 那一整条来路跟着目标门走').toMatch(
      /#\[cfg\(windows\)\]\s+pub struct DlssnrJob<'a> \{/,
    );
    expect(proxy, '摆盘的两个 helper 也是').toMatch(/#\[cfg\(windows\)\]\s+fn stage_settings\(/);
    expect(proxy, '为什么门在这里，得写在旁边').toContain('DLSSNR 那一档是**目标门**');
    expect(proxy, '别把这条来路悄悄删掉，调度器那边按 id 找它').toContain(
      'pub const DLSSNR_STAGE_ID: &str = "dlssnr";',
    );

    const manager = read('../../src-tauri/src/compute/manager.rs');
    expect(manager, '显存读数照 physical_ram_bytes 的样子分岔').toMatch(
      /#\[cfg\(not\(windows\)\)\]\s+fn gpu_memory_reading\(\) -> Option<\(u64, u64\)> \{\s+None\s+\}/,
    );
    expect(manager, '非 Windows 上「量不到」要老实说量不到，不许拿 0 冒充').toContain(
      '「不知道」不是「没压力」，与 [`physical_ram_bytes`]',
    );

    // 非 Windows 那一侧不是「少了一块」，是换了一条会说实话的路：命令名在所有平台都得存在
    // （`generate_handler!` 要它），叫到就回一句「不可用」。前端是按名字调的，悄悄删掉就是
    // 一句没人接的话。
    const hostDlssnr = read('../../src-tauri/src/dlssnr/mod.rs');
    expect(hostDlssnr, '命令壳在所有平台都编，别偷偷删掉').toContain('PLATFORM_UNAVAILABLE');
    expect(hostDlssnr, '叫到就回一句人话').toContain('DLSSNR 只在 Windows 桌面端可用');
    expect(hostDlssnr, 'Windows 那一份才是真的引擎').toMatch(
      /#\[cfg\(windows\)\]\s+pub use yomika_compute_core::dlssnr::\*;/,
    );

    // APK 那一份自己怎么验：一个 zip 的条目面 + 字节面。每一条都对应一个「换台机器也成立」
    // 的事实（见 `verify-compute-package.ps1` 里 `-Apk` 那段的长注释）。
    const verifier = read('../../.github/scripts/verify-compute-package.ps1');
    expect(verifier, 'APK 是第二条来路，不是顺手改一个参数').toContain('if ($Apk) {');
    expect(verifier, '桌面那两半与运行库的名字不许在').toContain("Note 'apk-no-desktop-exe'");
    expect(verifier, '这一份包只该有 arm64-v8a 的两份 .so').toContain(
      "$expectedLibs = @('lib/arm64-v8a/libc++_shared.so', 'lib/arm64-v8a/libyomika_lib.so')",
    );
    expect(verifier, '字节面要查引擎的名字').toContain(
      "$found = Find-Literals $libBytes @('yomika_ngx_init', 'd3d12.dll', 'DirectML.dll', 'nvngx_dlssnr', 'onnxruntime')",
    );
    expect(verifier, '`ort-api` 是标签不是罪证，别再误报一次').toContain('**不查 `ort-api`**');
    expect(verifier, '两句话得真在包里，不然那个入口在 Android 上就是没了').toContain(
      "$found = Find-Literals $libBytes @('找不到 worker 可执行文件', 'DLSSNR 只在 Windows 桌面端可用')",
    );
    expect(verifier, '`Find-Literals` 的针要先编成 UTF-8，中文才找得到').toContain(
      '$pattern = [System.Text.Encoding]::GetEncoding(28591).GetString([System.Text.Encoding]::UTF8.GetBytes($needle))',
    );
    expect(verifier, '换版本那一幕：APK 里那一份 .so 也要带这一次的构建戳').toContain(
      '& $stampScript -Path $apkItem.FullName -InsideApk',
    );
    expect(verifier, '资产协议的 scheme 得在内嵌配置里').toContain(
      "$ok = $configText.Contains('yomika-image:')",
    );
    // 两条来路共用同一份收尾。抽晚了就是 `& $stampScript` 拿到 `$null`——那个 bug 第一次跑
    // 时红在自检自己身上（6 项绿、1 项红）。
    expect(verifier, '收尾抽成一个函数').toContain(
      'function Write-Report([bool] $Ok, [int] $Bad, [string] $Subject) {',
    );
    expect(verifier, '构建戳脚本的路径要在分岔之前就定好').toContain(
      '$stampScript = Join-Path $PSScriptRoot "verify-build-stamp.ps1"',
    );
    expect(verifier, 'APK 这一条也要收尾').toContain(
      'Write-Report ($script:bad -eq 0) $script:bad $apkItem.FullName',
    );
    expect(verifier, '便携目录那一条的收尾走同一个函数').toContain(
      'Write-Report ($script:bad -eq 0) $script:bad $target',
    );
  });

  it('hands a stranger a package it can run, and says what that package cannot do', () => {
    // Task 10 第 ⑤ 条与出口条件（`docs/71:666`/`:668`）：包里该有四样、跑起来是什么样、
    // 用户数据不许被弄坏、两半不是同一次构建时主窗不许被挡住。这些不是「CI 里看一眼」，
    // 是交付前在**这份拷贝上**跑得出来的入口。
    const packager = read('../../.github/scripts/package-windows.ps1');
    // 三样缺一件就红。worker 不在这一列里：它在主 exe 的载荷里，包面出现第二份反而是
    // 缺陷（`no-separate-worker` 那一条查的就是它）。
    expect(packager, '包里该有的三样：主 exe、运行库、随包模型').toContain(
      "'main-exe'    = Join-Path $targetDir 'yomika.exe'",
    );
    expect(packager, 'worker 不再单列：多列一项等于要求包里出现第二份').toContain(
      'worker 不再单列：它现在在主 exe 的载荷里',
    );
    expect(packager, '摆进包里的就两个可执行/库文件，worker 不许跟着拷').toContain(
      "foreach ($name in @('yomika.exe', 'DirectML.dll')) {",
    );
    expect(packager, '缺件要当场说清楚缺的是哪一件').toContain('[BAD] 交付包里缺了该有的东西：');
    expect(packager, '自检要单起一个 pwsh（那个脚本用 exit 1）').toContain(
      "& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'verify-compute-package.ps1') -Path $stage",
    );
    // `-Stage` 会让自检**先往那个目录里补文件**，于是「stage 里少了 worker」被它自己补上、
    // 自检全绿，而 zip 早就压好了（2026-10-08 变异 A 实测）。自检要读即将发布的那一份本身。
    expect(packager, '自检读的是即将发布的那一份，不许先把它补全').not.toContain(
      "verify-compute-package.ps1') -Stage $stage",
    );
    expect(packager, '清单跟着包一起写出来').toContain(
      "& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'release-manifest.ps1') -Package $stage -Out $manifestPath",
    );
    expect(packager, '冷启动拿**刚压出来的那个 zip** 跑，不是拿目录').toContain(
      "-Package $output -Expect ready -Out $coldOut",
    );

    const workflow = read('../../.github/workflows/build-packages.yml');
    expect(workflow, 'CI 与本地必须是同一条打包命令').toContain(
      './.github/scripts/package-windows.ps1 -TargetDir src-tauri/target/release',
    );
    expect(workflow, '清单要跟着包一起发，不然 hash 只在摘要里翻不回来').toContain(
      'windows-x64 artifacts/yomika-windows.zip artifacts/release-manifest.json',
    );

    const coldStart = read('../../.github/scripts/verify-cold-start.ps1');
    expect(coldStart, '便携包按白名单摆，不搬开发机那一整棵 data/').toContain(
      "foreach ($name in @('yomika.exe', 'DirectML.dll')) {",
    );
    // 冷启动是「单文件」这句话最终的判据：把主 exe 单独摆进一个空目录，它得自己把
    // 载荷落出来、再拉起来（日志里那句「把随包的 worker 落到 …」）。
    expect(coldStart, '这一跑也要说得出拷贝里有没有第二份 worker').toContain('包面第二份 worker');
    expect(coldStart, '主 exe 里那份载荷要解得开').toContain('Read-WorkerPayload -HostExe');
    expect(coldStart, '载荷坏掉那一幕不能靠删文件来演：删的是文件，坏的是字节').toContain(
      "[switch] $BreakPayload",
    );
    expect(coldStart, '拿另一份宿主来演「不是同一次构建」，而不是换一份 worker 文件').toContain(
      "[string] $SwapHost = ''",
    );
    expect(coldStart, '故意造的现场不许记成 [BAD]，否则读报告的人分不清哪条是真缺陷').toContain(
      '故意弄坏（这一跑量的是它坏掉之后会怎样）',
    );
    // 两扇窗刚起来时都是 about:blank：只看「不是托盘菜单」会把托盘那一页当主窗接上
    // （2026-10-08 实测：探针挂上去等满 60 秒，日志还写着「主窗起来了」）。
    expect(coldStart, '主窗要等到它真落在自己的页面上才算数').toContain(
      "$_.type -eq 'page' -and $_.url -like 'http*' -and $_.url -notlike '*tray-menu*'",
    );
    expect(coldStart, '干净环境里也要有 WebView2 的调试端口').toContain(
      'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
    );
    expect(coldStart, '跑两遍时要看第一跑的数据有没有少').toContain('data-survives');
    expect(coldStart, '探针也要拿到端口：列表是快照，连上去才是现场').toContain("'--port', \"$port\",");

    const probe = read('../../.github/scripts/cold-start-probe.mjs');
    expect(probe, '挑主窗要先连上去问一句它现在挂在哪').toContain('const chosen = await chooseTarget(port, wsUrl);');
    expect(probe, '两族地址都要问：托盘与主窗可能分别绑在 IPv4/IPv6').toContain("for (const host of ['127.0.0.1', '[::1]']) {");
    expect(probe, '接错了就换一条，别硬着头皮等 60 秒').toContain('throw new Error(`没有一页能接：');
    expect(probe, '`JobState` 带数据的变体是对象，不是字符串').toContain(
      "const stateName = (state) => (typeof state === 'string' ? state : state && typeof state === 'object' ? Object.keys(state)[0] : null);",
    );

    const manifest = read('../../.github/scripts/release-manifest.ps1');
    expect(manifest, '反引号只能这样拼：嵌在子表达式里的双引号串放转义反引号会解析失败').toContain(
      "function Quote([string] $text) { return '``' + $text + '``' }",
    );
    expect(manifest, '协议大版本要从协议 crate 里读出来，不许手抄').toContain('PROTOCOL_MAJOR:\\s*u32\\s*=\\s*(\\d+)');
    expect(manifest, '构建戳那条判据是「有没有抛」，不是 `$LASTEXITCODE`').toContain(
      "} catch { $stamps['main'] = $false }",
    );
    expect(manifest, 'worker 那一半同样：解出来的字节对不上戳就如实记假').toContain(
      "} catch { $stamps['worker'] = $false }",
    );
    // 判据自己也要被钉住：把「有没有抛」换成 `$LASTEXITCODE`，两种现场就读成一样了
    // （那个变量的值是上一条本机命令留下的）。
    expect(manifest, '为什么不能拿 $LASTEXITCODE 当结论，理由要留在原地').toContain('有没有抛');

    // 交付的是一个文件：清单与自检都要从主 exe 里把 worker 的字节解出来，再问它带的是
    // 不是这一次的戳（10-a 的握手就是拿这两半比）。
    expect(manifest, '清单不自己扫字节猜：载荷用同一个读端解').toContain(
      '$reading = Read-WorkerPayload -HostExe (Join-Path $content \'yomika.exe\')',
    );
    expect(manifest, '载荷那一栏要写清它在哪、多大、摘要、戳对不对').toContain(
      "where  = 'embedded in yomika.exe'",
    );
    expect(manifest, '给人的那一份也要说得出「跑起来仍是独立进程」').toContain('跑起来仍是独立进程');

    const operators = read('../../docs/14-release-and-operations.md');
    expect(operators, '运行命令要写在文档里，不是只活在 CI 里').toContain('.github/scripts/package-windows.ps1');
    expect(operators, '便携布局的事实要写清楚：数据落在 exe 同级').toContain('data/webview/EBWebView/');
    expect(operators, '已知限制要一条条列出来').toContain('已知限制（每条都有实测依据）');

    // 这一条是这一轮真正的发现：`BUILD_COMMIT` 那一串在 release 里**不会**以明文留在
    // `.rdata`（LLVM 折成立即数），留给打包核查的是另一份字节形态。所以「按字节改一份
    // 构建戳」改得动核查、改不动协议——真要不一致，得真编一份。
    const workerLib = read('../../src-tauri/worker/src/lib.rs');
    expect(workerLib, '协议报的那一串与核查找的那一份是两件事').toContain('pub const BUILD_COMMIT: &str = env!("YOMIKA_BUILD_COMMIT");');
    expect(workerLib, '为什么要另留一份字节形态：release 里明文会被折掉').toContain('根本不会留下这一串明文');
    // 三个属性连在一起钉：`#[used]` 在这个文件里出现两次（另一处在文档注释里），
    // 只钉它一个的话，把属性摘掉也照样绿。
    expect(workerLib, '这一份字节形态不能被链接器收走').toMatch(
      /#\[used\]\r?\n#\[no_mangle\]\r?\npub static YOMIKA_BUILD_COMMIT_STAMP: \[u8; BUILD_COMMIT\.len\(\)\] = build_commit_bytes\(\);/,
    );
  });

  it('keeps the library an older build left behind, and keeps a copy of it before upgrading', () => {
    // Task 10 出口条件（`docs/71:668`）的「升级/回退可恢复」与「用户数据无破坏」：迁移只往前写，
    // 升级不可逆，而用户的数据目录里没有第二个副本 —— 所以升级前先留一份，留不下就不升。
    // 回退那一半反过来：遇到比自己新的档位，一个迁移都不许 apply，更不许把档位改小。
    const database = read('../../src-tauri/src/db/mod.rs');
    expect(database, '升级前那一份的名字里带档位：不打开它也知道它对应哪一版').toContain(
      'path.with_file_name(format!("{name}.pre-v{current}.bak"))',
    );
    expect(database, '备份要用 VACUUM INTO：出来的是一份独立的库，不是 WAL 的一条尾巴').toContain(
      '.execute("VACUUM INTO ?1", [target.to_string_lossy().into_owned()])',
    );
    expect(database, '不旧不备：只给比这一版旧的库留备份').toContain('if current > 0 && current < last {');
    expect(database, '备份失败就不升：宁可这一次起不来，也不要升上去之后回不去').toContain(
      '"升级前没能把数据库备份到 {}：{error}；这一版没动这个库"',
    );
    expect(database, '回退那一半：别人写下的档位不许被改小').toContain(
      'assert_eq!(version, 99, "别人写下的档位不许被改小");',
    );
    expect(database, '备份里该还是升级前那一档，行也还在').toContain(
      'assert_eq!(backup_version, 10, "备份里该还是升级前那一档");',
    );
    expect(database, '夹具跑的是仓库自己的迁移，不手抄建表语句').toContain(
      'for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version <= up_to) {',
    );

    // 冷启动那一侧：旧库现场用仓库自己的迁移 SQL 造（node:sqlite，Node 24 自带），
    // 仓库里不放二进制、也不要求测试机上装着旧版本。
    const legacy = read('../../.github/scripts/legacy-database.mjs');
    expect(legacy, '夹具跑的是仓库自己的迁移').toContain(
      "const migrationsDir = join(repo, 'src-tauri', 'migrations');",
    );
    expect(legacy, '老库该有的样子：服务器、档案、读到一半的位置、一行设置').toContain(
      ".prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')",
    );
    expect(legacy, '后加的列/表在不在，就是「真的迁移过」的证据').toContain(
      "ask(\"SELECT COUNT(*) AS n FROM pragma_table_info('archives') WHERE name = 'added_at'\")?.n ??",
    );
    expect(legacy, '读不到是「不知道」，不是「没有」').toContain('return null;');

    const cold = read('../../.github/scripts/verify-cold-start.ps1');
    expect(cold, '旧库要摆进去，不是凭空起一个').toContain(
      "Copy-Item -LiteralPath $seedPath -Destination (Join-Path $dataDir 'yomika.sqlite3') -Force",
    );
    expect(cold, '摆进去的那一份得真是第 10 档').toContain('--make $seedPath --up-to 10');
    expect(cold, '备份里该还是升级前那一档').toContain('$backupReading.version -eq 10');
    expect(cold, '主库升到本版档位，行都还在').toContain('$upgraded.version -eq 30');
    expect(cold, '升级那一半也是冷启动的一条').toContain('[switch] $SeedLegacy,');
    expect(cold, '用户自己的文件一字没动').toContain(
      'Note "run${index}-seed-marker" ($markerNow -eq $seedMarkerText)',
    );

    const packager = read('../../.github/scripts/package-windows.ps1');
    expect(packager, '打包时两种冷启动都要跑').toContain(
      '-Package $output -SeedLegacy -Expect ready -Out $coldOutLegacy',
    );
    expect(packager, '两种读数分开放，免得「最后一个就是它」').toContain(
      "$coldOutLegacy = Join-Path $artifactsDir 'cold-start-legacy'",
    );
    expect(packager, '交付的那个 zip 本身要交给清单，不是把 stage 目录交给它').toContain('-Archive $output');

    const manifest = read('../../.github/scripts/release-manifest.ps1');
    expect(manifest, 'zip 自己的字节数与 sha256 也进清单').toContain(
      'sha256 = (Get-FileHash -LiteralPath $archiveItem.FullName -Algorithm SHA256).Hash.ToLower()',
    );
    expect(manifest, '旧库那一半的读数是清单的一部分').toContain('coldStartLegacy = $coldStartLegacy');
    expect(manifest, '旧库那一半的读数得有地方接').toContain("[string] $ColdStartLegacyReport = '',");
  });

  it('puts the window back the way it found it, and says which build it measured', () => {
    const probe = read('../../.github/scripts/compute-ui-probe.mjs');
    expect(probe, '打包构建那一档要有一个「不 import 应用模块」的开关').toContain(
      "const noQuiet = Boolean(args['no-quiet']);",
    );
    expect(probe, '光杆开关不能被当成「下一条参数是它的值」').toContain(
      "    if (next === undefined || next.startsWith('--')) {",
    );
    expect(probe, '光杆开关自己就是真，不占下一条').toContain('      args[key.slice(2)] = true;');
    expect(probe, '关偏好那一整块要有条件，不能在打包构建里照跑').toContain('if (!noQuiet) {');
    expect(probe, '被关掉的那几栏要连同整份快照一起交回 Node').toContain(
      '    return { before: turnedOff, after: { upscaleBackend: saved.value.upscaleBackend, decensorModel: saved.value.decensorModel }, snapshot };',
    );
    expect(probe, '还原要用整份快照，不是把四栏写回原值').toContain(
      '    const saved = await repository.save(${JSON.stringify(quietSnapshot)});',
    );
    expect(probe, '还原这一步要留在最后的读数里').toContain('    restored: quietRestored,');
    expect(probe, '没还回去必须让这一跑红，不能只打印一句').toContain(
      "if (quietRestored && !quietRestored.ok) throw new Error('偏好没还回去：' + JSON.stringify(quietRestored));",
    );
    expect(probe, '跳过偏好那一档要在读数里自报家门').toContain(
      '这一档是打包构建（--no-quiet）：import 不了应用的模块，也没法把偏好改回去；跑之前偏好就该是关的（跑在库的副本上）',
    );

    const harness = read('../../.github/scripts/measure-compute-responsiveness.ps1');
    expect(harness, '打包构建那一档要有自己的开关').toContain('[switch] $UiBundled,');
    expect(harness, '开关要真传给驱动，不然它照旧去 import 应用模块').toContain(
      "if ($UiBundled) { $arguments += @('--no-quiet') }",
    );
    expect(harness, '打包构建里挑不出档案这件事要说清楚，而不是让它自己去 import 然后报错').toContain(
      'throw "-UiBundled 量的是打包构建：那边 import 不了 /src/**，挑不出档案，必须点名 -UiReaderUrl"',
    );
    expect(harness, '读数里要写明这一档量的是哪一份构建').toContain(
      'bundled = [bool]$UiBundled; targetUrl = $target.url',
    );
    expect(harness, 'summary 里两个档不能长得一样').toContain('这一档量的是**打包构建**');
    expect(harness, 'dev 那一档也要说清楚它的数里含什么').toContain('这一档量的是 **dev 构建**');
    expect(harness, '量到了却没达到门槛时，不许从「没测」里撤掉就当达标了').toContain(
      'if ($navP95 -gt 150) {',
    );
    expect(harness, '这一条要写成「量到了，没达到」，并把这个数写进去').toContain(
      '§12.3 简单导航/返回原图可见 p95 ≤ 150 ms（量到了，没达到：这一跑 p95 = $navP95 ms）',
    );
  });

  it('judges a page that arrives while the breaker is lit, and lets the two orderings agree', () => {
    const manager = read('../../src-tauri/src/compute/manager.rs');
    expect(manager, '熔断亮着的时候也要看一眼队列').toContain(
    'if let Some(reason) = self.broken.clone() {',
  );
    expect(manager, '这句话得留在代码里：为什么不许像「没有活要跑」那样直接 return').toContain(
      '熔断亮着：这台机器/这个包在用户动手（点重试）之前都跑不了，**排队的活当场给结论**。',
    );
    expect(manager, '排队的活当场拿结论，不是等用户点重试').toContain(
      `        if let Some(reason) = self.broken.clone() {
            // 这一条判的是用户看得见的活，状态就得跟它说同一件事：\`end_session\` 在退避与熔断
            // 之间可能已经把状态收回 \`Stopped\`（那一下队列还空着），而界面是照状态决定要不要
            // 给「重试」的。「页面被判成不可用」和「界面说不忙」不能是两套说法。
            let now_ms = self.shared.now_ms();
            let failed = self.shared.with_state(|state| {
                state.status = WorkerStatus::Broken { reason };
                state.scheduler.fail_queued(WORKER_UNAVAILABLE_CODE, now_ms)
            });
            self.shared.emit(&failed);
            return;
        }`,
    );
    expect(manager, '判活与状态要落在同一个闭包里：分开写就有中间态').toContain(
      `            let failed = self.shared.with_state(|state| {
                state.status = WorkerStatus::Broken { reason };
                state.scheduler.fail_queued(WORKER_UNAVAILABLE_CODE, now_ms)
            });`,
    );
    expect(manager, '「熔断亮着」不许再和「没有活要跑」挤在同一个 return 里').not.toContain(
      'if self.session.is_some() || self.broken.is_some() || !self.has_queued() {',
    );

    const storm = read('../../src-tauri/tests/compute_restart_storm.rs');
    expect(storm, '这一种现场要有自己的用例').toContain(
      'fn a_tripped_breaker_judges_the_queued_page_and_waits_for_an_explicit_retry() {',
    );
    expect(storm, '60 秒窗口里第 4 次才点得亮，所以这里连打 4 次').toContain('for round in 0..4u32 {');
    expect(storm, '熔断的理由要说得出是重启次数到顶').toContain('reason.contains("重启次数到顶")');
    expect(storm, '等待预算 15 秒：躺着的活不许靠「等久一点」蒙过去').toContain(
      `        "熔断亮着时交的活该当场有结论",
        Duration::from_secs(15),`,
    );
    expect(storm, '结论必须是 COMPUTE_WORKER_UNAVAILABLE').toContain(
      `        JobState::Failed {
            code: "COMPUTE_WORKER_UNAVAILABLE".to_string(),
        },`,
    );
    expect(storm, '这个结论得发出去：界面是靠事件流知道一件活已经完了').toContain(
      '        "这个结论得**发出去**：界面是靠事件流知道一件活已经完了"',
    );
    expect(storm, '被当场判掉的活不许留下产物').toContain(
      '        "被当场判掉的活不该留下任何产物"',
    );
    expect(storm, '判掉排队的活不该把熔断本身抬起来').toContain(
      '        "判掉一件排队的活不该把熔断本身抬起来"',
    );
    expect(storm, '用户点过重试之后，同一页要照样算出来').toContain(
      'assert_eq!(state, JobState::Completed, "点过重试之后同一页该算出来");',
    );
    expect(storm, '20 轮那条用例要容忍「熔断/退避正好在检查与提交之间」这条缝').toContain(
      'let judged_unavailable = matches!(',
    );
    expect(storm, '容忍是有界的：只允许这一种现场重来，别的一律照旧红').toContain(
      'if judged_unavailable && no_worker_can_take_it && attempt < 3 {',
    );
    expect(storm, '这条缝本身要写在注释里，不然下一个人会把它当偶发').toContain(
      '`end_session` 先把任务判完、再去\n        // 重启记账，中间那一段是缝',
    );
  });

  it('refuses a page DLSSNR cannot take without calling it a broken engine, and keeps the reason', () => {
    const stage = read('../../src-tauri/worker/src/dlssnr.rs');
    const manager = read('../../src-tauri/src/compute/manager.rs');
    const proxy = read('../../src-tauri/src/compute/proxy.rs');

    // 太小/太大是「这一页没有可算的东西」，不是引擎坏了：原图交回、不报错，也不为它
    // 装片段（`hand_back` 在那道门后面才轮得到）。
    expect(stage, '两道尺寸门写在代码里，不是散在 if 里').toContain(
      'fn page_fits(width: u32, height: u32) -> Result<(), String> {',
    );
    expect(stage, '下界是核心那个常量，不许再抄一遍 32').toContain(
      'if width < filter::MIN_EDGE || height < filter::MIN_EDGE {',
    );
    expect(stage, '上界是 D3D12 给 2D 纹理的硬指标').toContain(
      'const MAX_TEXTURE_EDGE: u32 = 16_384;',
    );
    expect(stage, '拒了就是原图交回，别报成引擎坏了').toContain(
      'return self.hand_back(&request, &source);',
    );
    expect(stage, '交回这件事要留一句在 stderr（本地跑的时候看得见）').toContain(
      'eprintln!("[worker] DLSSNR 跳过这一页：{why}");',
    );

    // worker 自己那句「为什么」不能丢：码是给前端认的，话是给人查的。
    expect(manager, '失败原因只在这一条消息里出现一次，要当场抄下来').toContain(
      'state.remember_failure_note(&failed.job_id, &failed.message);',
    );
    expect(manager, '抄下来的份数要封顶（失败是逐页发生的）').toContain(
      'const MAX_FAILURE_NOTES: usize = 64;',
    );
    expect(manager, '代理要有一个窄口子拿到它').toContain(
      'pub fn failure_note(&self, job_id: &str) -> Option<String> {',
    );
    expect(proxy, '文案里要带上 worker 的原话').toContain('Some(note) => format!("{message}：{note}"),');
    expect(proxy, '前端的码仍然只认翻译后的那一个').toContain(
      'let note = manager.failure_note(&submitted.job_id);',
    );
  });

  it('tells two community snippets apart by hash, and never by their size', () => {
    const core = read('../../src-tauri/crates/compute-core/src/dlssnr/mod.rs');
    const metadata = read('../../src-tauri/crates/compute-core/tests/dlssnr_metadata.rs');
    const updates = read('../../src/lib/dlssnrUpdates.ts');
    const repository = read('../../src/repositories/nativeDlssnrRepository.ts');
    const group = read('../../src/components/DlssnrSettingsGroup.tsx');
    const row = read('../../src/components/SettingsRow.tsx');

    // 官方原版与社区兼容版都是 165,840,496 字节——**只有哈希分得开**。所以「装的是哪一版」
    // 这件事，后端得把哈希说出来，前端只能拿哈希去比。
    expect(core, '盘上那份的哈希要有一栏说得出').toContain('pub dll_sha256: Option<String>,');
    expect(core, '认变体与报哈希共用同一遍读，别把那 165 MB 读两遍').toContain(
      'let fingerprint = dll_bytes.is_some().then(|| cached_fingerprint(&dll)).flatten();',
    );
    expect(core, '报出去的就是指纹本身').toContain('dll_sha256: fingerprint.map(|(_, digest)| digest),');
    expect(metadata, '量的是文件自己的哈希，不是长度').toContain('"指纹是这份文件自己的哈希"');

    expect(repository, '状态里那一栏跟着协议走，老后端没有也收').toContain(
      'dllSha256: z.string().nullable().optional(),',
    );

    expect(updates, '两份哈希按同一口径比（大小写与空白不算数）').toContain(
      'function sameDigest(left: string | null | undefined, right: string | null | undefined): boolean {',
    );
    expect(updates, '装的是哪一条：先按清单的哈希认，认不出才退回内置表').toContain(
      'const hit = catalog?.variants.find((variant) => sameDigest(variant.sha256, digest));',
    );
    expect(updates, '哈希读不出来时什么都不报——退回字节数就是凭猜').toContain(
      'if (!id || !installed?.trim() || !catalog) return [];',
    );
    expect(updates, '同一份字节不算更新').toContain('if (!variant || sameDigest(variant.sha256, installed)) return [];');

    expect(group, '行上那一枚标记看的是更新表，不是「目录在不在」').toContain(
      "mark={variantUpdates.length > 0 ? '有更新' : undefined}",
    );
    expect(group, '哪一条装了：按哈希认，不再比 id 字面量').toContain('const installedVariant = installedVariantId(status, catalog);');
    expect(group, '换过资产的那一条是「有更新」的那一条').toContain('const outdated = outdatedVariants.has(variant.id);');
    expect(group, '行尾动作跟着改叫更新').toContain('outdated={outdated}');
    expect(group, '文件在却不认识时不许说「未安装」').toContain("status.dllPresent ? '认不出的片段' : '未安装'");

    expect(row, '标记跟着名字走，不占控件那一格').toContain('mark?: ReactNode | undefined;');
    expect(row, '画的还是那一枚 pill（一处定义）').toContain('<span className="settings-row-mark">{mark}</span>');
  });

  it('asks the driver’s question before a snippet replaces the one that works', () => {
    const core = read('../../src-tauri/crates/compute-core/src/dlssnr/mod.rs');
    const cargo = read('../../src-tauri/crates/compute-core/Cargo.toml');
    const metadata = read('../../src-tauri/crates/compute-core/tests/dlssnr_metadata.rs');
    const release = read('../../src-tauri/src/dlssnr/release.rs');
    const commands = read('../../src-tauri/src/dlssnr/commands.rs');

    // 三个答案要分开：签过名且内容对得上、签过名但被改过、压根没签名。混成一个 bool 就
    // 说不出「为什么我下的这一份装不上」——而那句话正是用户唯一能看到的东西。
    expect(core, '三个答案各有名字').toContain('pub enum SignatureVerdict {');
    expect(core, '量的是 Windows 的验签，不是我们自己编的规则').toContain('        WinVerifyTrust(');
    expect(core, '「签过名再改过」要单独认出来').toContain('        TRUST_E_BAD_DIGEST => SignatureVerdict::Modified,');
    expect(core, '那一个 HRESULT 写成字面量，对照的就是它').toContain('const TRUST_E_BAD_DIGEST: i32 = 0x8009_6010u32 as i32;');
    expect(cargo, 'WinTrust 那一节要开').toContain('"Win32_Security_WinTrust"');
    expect(cargo, 'WINTRUST_DATA / _FILE_INFO 在 Cryptography 那一节').toContain('"Win32_Security_Cryptography"');

    // 「装之前拦一道」：带策略的入口 + 产品路径要签名 + 两句话各说各的拒绝理由。
    expect(core, '策略是个有名字的参数，不是一个秘密开关').toContain('pub enum SnippetTrust {');
    expect(core, '产品的导入路径就是「要签名」那一支').toContain(
      '    install_dll_with(source, data_dir, SnippetTrust::Required)',
    );
    expect(core, '拦的位置在尺寸与 PE 之后、落盘之前').toContain('    if trust == SnippetTrust::Required {');
    expect(core, '拒绝的那句话要说得出是哪一种不过').toContain(
      'pub fn require_trusted_snippet(path: &std::path::Path) -> Result<(), String> {',
    );
    expect(core, '改过的那种：驱动只加载签名对得上的').toContain('驱动只加载签名对得上的片段');
    expect(core, '没签名的那种：驱动只加载签过名的').toContain('驱动只加载签过名的片段');

    // 两个真片段各自的答案不一样（本机量到的）：兼容版是「签过名再改过」，SF-v2 是没签名。
    expect(core, '一个字节的改动也是改过').toContain('"翻一个填充字节就不再是同一份文件：签名说的就是这件事"');
    expect(core, '社区那两版的拒法在测试里分开钉着').toContain(
      '            ("SF-v2", super::SignatureVerdict::Untrusted),',
    );

    // 宿主那一条下载路径同样要问；而仓库里拿假 PE 当夹具的用例必须**显式**跳过。
    expect(release, '下载路径也走「要签名」那一支').toContain(
      '    install_staged_with(staged, data_dir, SnippetTrust::Required)',
    );
    expect(release, '就位之前先问').toContain('        require_trusted_snippet(staged)?;');
    expect(release, '这一条用真片段，因为签名问的是文件自己').toContain(
      'fn a_snippet_whose_signature_does_not_check_out_is_not_put_in_place()',
    );
    expect(metadata, '假 PE 没有签名，所以那三个用例显式跳过').toContain(
      'install_dll_with(&source, dir.path(), SnippetTrust::Skipped)',
    );
    expect(commands, '宿主的假夹具也一样显式跳过').toContain('crate::dlssnr::SnippetTrust::Skipped,');
  });

  it('buzzes on a hold through one path, and only where a motor exists', () => {
    const manifest = read('../../src-tauri/gen/android/app/src/main/AndroidManifest.xml');
    const host = read('../../src-tauri/gen/android/app/src/main/java/app/yomika/reader/MobileHost.kt');
    const bridge = read('../../src-tauri/src/mobile_host.rs');
    const platform = read('../../src-tauri/src/commands/platform.rs');
    const lib = read('../../src-tauri/src/lib.rs');
    const menu = read('../../src/lib/longPressMenu.ts');
    const haptics = read('../../src/lib/haptics.ts');

    // 少了这条权限，`Vibrator.vibrate` 会被系统**静默忽略**：手机上什么都没发生，日志里
    // 也没有一行。长按的确认本来就只是「手感」，坏了最容易被当成没事。
    expect(manifest, '震动要权限：缺了不报错，只是不震').toContain(
      '<uses-permission android:name="android.permission.VIBRATE" />',
    );

    // 有马达才动手；旧到没有 `createPredefined` 的机器也要震得出来（minSdk 24）。
    expect(host, '原生侧一条命令').toContain('  fun vibrate(invoke: Invoke) {');
    expect(host, '没有马达就安静收场').toContain('if (vibrator?.hasVibrator() == true) {');
    expect(host, 'API 31 起震动器归 VibratorManager 管').toContain('VIBRATOR_MANAGER_SERVICE');
    expect(host, '档位映射到系统预置效果').toContain(
      'VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK)',
    );
    expect(host, '低版本退成一次性振动，而不是没有反馈').toContain('vibrator.vibrate(milliseconds)');

    expect(bridge, 'Rust 侧转一手').toContain('pub async fn vibrate(app: &AppHandle, kind: &str) -> Result<(), String> {');
    expect(bridge, '命令名与原生侧那一支对得上').toContain(
      'call::<serde_json::Value>(app, "vibrate", json!({ "kind": kind }))',
    );
    expect(platform, '宿主命令：桌面上是空操作而不是失败').toContain(
      'pub async fn haptic_feedback(app: tauri::AppHandle, kind: String) -> CommandResult<()> {',
    );
    expect(platform, 'Android 那一支真的转过去').toContain('crate::mobile_host::vibrate(&app, &kind).await');
    expect(lib, '注册进宿主名单：这一行是名单里的（12 个空格缩进），不是 use 那一行').toContain(
      '            haptic_feedback,',
    );

    expect(menu, '长按才发这一下，而且是三个调用点共用的那一处').toContain("        hapticFeedback('medium');");
    expect(menu, '和打开菜单同一个定时器里：按住了就一定有反馈').toContain(
      "        hapticFeedback('medium');\n        open({ x: hold.x, y: hold.y });",
    );
    expect(haptics, '只有手机有马达，判据就是 UA').toContain('/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)');
    expect(haptics, '发射即忘：反馈拿不到不该把长按弄失败').toContain('.catch(() => {});');

    // 这条命令只该有一个出口。多一个人去叫它，桌面上就多一趟白跑的 IPC，手机上则会连震
    // 两下——而「只在长按那一处发」正是这三个调用点共用同一个处理器换来的。
    const root = resolve(__dirname, '../..', 'src');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
      (entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'),
    );
    const offenders: string[] = [];
    for (const entry of files) {
      if (/(^|[\\/])lib[\\/]haptics\.ts$/.test(entry)) continue;
      if (readFileSync(resolve(root, entry), 'utf8').includes('haptic_feedback')) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });

  it('answers the tag count fetch in the bridge envelope, with codes the table knows', () => {
    const tagcount = read('../../src-tauri/src/tagcount.rs');

    // 这一条就是本项缺陷的判据。裸 `Result` 的成功形状是 `{"version":…}`、失败时是一个
    // **字符串**，两种都不像 `{ ok: true, value }` / `{ ok: false, error }`：`src/bridge/invoke.ts`
    // 先按信封判一次，判不过就落成
    // `bridge/fetch_tag_counts  Native command returned an invalid response`——每一次刷新
    // 都失败（用户 2026-10-12 的 error.log 正是这个形状），标签补全排序一条频次都拿不到。
    expect(tagcount, '取数命令要回信封').toContain(
      'pub async fn fetch_tag_counts(since: Option<String>) -> CommandResult<TagCountTable> {',
    );
    expect(tagcount, '不能再有裸 Result 的那条命令').not.toContain(
      'async fn fetch_tag_counts(since: Option<String>) -> Result<TagCountTable',
    );

    // 信封里那几个码必须在 `src/domain/errors.ts` 的闭集里：没登记过的码不是「原样透传」，
    // 而是整条被判成 `INVALID_RESPONSE`，真正的理由（离线、资产没发布、字节坏了）反而看不见。
    const codes = [...tagcount.matchAll(/code: "([A-Z_]+)"/g)].map((match) => match[1] ?? '');
    expect(codes, '至少要说清两种失败：拿不到字节、字节不能用').toEqual(
      expect.arrayContaining(['NETWORK', 'INVALID_RESPONSE']),
    );
    for (const code of codes) {
      expect(DomainErrorCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });

  it('the CSP lets the webview load the lease URL in the shape this platform can actually reach', () => {
    // Windows/Android 上 WebView 只把「HTTP 请求」交给自定义 scheme 处理器：wry 注册的是
    // `http://yomika-image.*` 的拦截表，处理器看到的是换回前缀后的
    // `yomika-image://localhost/asset/{id}`。所以取图地址是
    // `http://yomika-image.localhost/asset/{id}`（Rust 侧 `compute::leases::lease_url`），
    // CSP 少这一条时 `<img>` 会被 CSP 挡掉——症状与 URL 形状写错一样：图片直接消失、
    // 错误日志里一行都没有（2026-10-13 真机）。
    const leases = read('../../src-tauri/src/compute/leases.rs');
    expect(leases, 'Windows/Android 的取图地址必须是 HTTP 形状').toContain(
      'format!("http://{SCHEME}.localhost/{HOST}/{lease_id}")',
    );
    const protocol = read('../../src-tauri/src/compute/asset_protocol.rs');
    expect(protocol, '处理器要认下 wry 换回来的 localhost 那一段').toContain(
      'rest.strip_prefix("localhost/").unwrap_or(rest)',
    );

    const config = readJson('../../src-tauri/tauri.conf.json') as {
      app: { security: { csp: string } };
    };
    const imageSources = config.app.security.csp
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === 'img-src')
      ?.slice(1) ?? [];
    expect(imageSources, 'img-src 要放行取图地址的来源').toContain('http://yomika-image.localhost');
  });
});
