import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

describe('native shell configuration', () => {
  it('registers both model release and reader inference commands', () => {
    const lib = read('../../src-tauri/src/lib.rs');
    const handlers = lib.split('tauri::generate_handler![')[1]?.split(']')[0] ?? '';
    for (const command of ['inference_install_decensor_bundle', 'inference_upscale_page', 'inference_decensor_page', 'model_release_download_bundle']) {
      expect(handlers.split(',').map((item) => item.trim())).toContain(command);
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
});
