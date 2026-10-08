#!/usr/bin/env node
// 造一个「旧机器上留下来的库」，以及在升级之后检查它变成了什么样。
//
// 为什么用仓库自己的迁移 SQL：夹具必须跟着迁移脚本一起变。手抄一份建表语句的夹具，
// 迟早会和真正的老库长得不一样，那时候它证明的就不是用户会遇到的那件事。
//
// 为什么用 node:sqlite：Node 24 自带（冷启动脚本本来就跑在装了 Node 的机器上，
// 前端要它），不必再要求一份 Python 或一个 sqlite3.exe —— 这台机器上两者都不保证有。
//
//   node legacy-database.mjs --make <out.sqlite3> [--up-to 10]
//   node legacy-database.mjs --inspect <db.sqlite3>
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const migrationsDir = join(repo, 'src-tauri', 'migrations');

// 一个旧库该有的样子：一台连不上的服务器、一份档案、一个读到一半的位置、一行设置。
// 挑的都是 0001/0002 就有的表，后面几档只往上加列，所以这些行升完必须原样还在。
const LEGACY_SERVER_ID = 'legacy-server';
const LEGACY_ARCHIVE_ID = 'legacy-1';
const LEGACY_TITLE = '这台机器上原来就有的档案';
const LEGACY_SETTING = 'legacy-marker';

function parseArgs(argv) {
  const options = { make: '', inspect: '', upTo: 10 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--make') {
      options.make = argv[index + 1] ?? '';
      index += 1;
    } else if (flag === '--inspect') {
      options.inspect = argv[index + 1] ?? '';
      index += 1;
    } else if (flag === '--up-to') {
      options.upTo = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
    } else {
      throw new Error(`不认识的参数：${flag}`);
    }
  }
  return options;
}

/// 仓库里的迁移按文件名排序，取档位不超过 `upTo` 的那些。
function migrationsUpTo(upTo) {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      if (!match) {
        throw new Error(`迁移文件名里读不出档位：${name}`);
      }
      return { version: Number.parseInt(match[1], 10), path: join(migrationsDir, name) };
    })
    .sort((left, right) => left.version - right.version)
    .filter((migration) => migration.version <= upTo);
}

function makeDatabase(target, upTo) {
  const migrations = migrationsUpTo(upTo);
  if (migrations.length === 0) {
    throw new Error(`一档都没选上（--up-to ${upTo}）：${migrationsDir}`);
  }
  if (existsSync(target)) {
    rmSync(target);
  }
  mkdirSync(dirname(target), { recursive: true });

  const database = new DatabaseSync(target);
  database.exec('PRAGMA foreign_keys = ON;');
  for (const migration of migrations) {
    database.exec(readFileSync(migration.path, 'utf8'));
  }
  // 逐档跑完再钉档位：迁移文件自己也会往老式的 schema_migrations 表里记一笔，
  // 那是另一套账；真正决定「这一版认不认这个库」的是 PRAGMA user_version。
  database.exec(`PRAGMA user_version = ${upTo};`);
  database
    .prepare('INSERT INTO servers (id, name, base_url, scope_id) VALUES (?, ?, ?, ?)')
    .run(LEGACY_SERVER_ID, '旧机器上的服务器', 'http://192.168.1.9:3000', 'legacy-scope');
  database
    .prepare(
      'INSERT INTO archives (server_id, archive_id, title, tags_json, page_count) VALUES (?, ?, ?, ?, ?)',
    )
    .run(LEGACY_SERVER_ID, LEGACY_ARCHIVE_ID, LEGACY_TITLE, '["legacy"]', 42);
  database
    .prepare(
      'INSERT INTO reading_progress (scope_id, archive_id, page_index, page_count, layout, direction) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('legacy-scope', LEGACY_ARCHIVE_ID, 7, 42, 'paged', 'ltr');
  database
    .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
    .run(LEGACY_SETTING, '{"left_over":"这台机器上原来就有"}');
  database.close();

  const tables = readTables(target).length;
  const bytes = statSync(target).size;
  console.log(`旧库夹具：${target}（档位 ${upTo}、表 ${tables} 张、${bytes} 字节）`);
}

function readTables(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
  } finally {
    database.close();
  }
}

/// 打开一个库把事实读出来。表可能是这一版才有的（升级前那份备份里就没有），
/// 所以每一问都独立兜底：读不到就是 `null`，不是「没有这一行」。
function inspectDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  const ask = (sql, ...params) => {
    try {
      return database.prepare(sql).get(...params) ?? null;
    } catch {
      return null;
    }
  };
  try {
    return {
      path,
      bytes: statSync(path).size,
      version: ask('PRAGMA user_version')?.user_version ?? null,
      tables: ask("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")?.n ?? null,
      server: ask('SELECT name FROM servers WHERE id = ?', LEGACY_SERVER_ID)?.name ?? null,
      archive: ask('SELECT title FROM archives WHERE archive_id = ?', LEGACY_ARCHIVE_ID)?.title ?? null,
      readingPage:
        ask('SELECT page_index FROM reading_progress WHERE archive_id = ?', LEGACY_ARCHIVE_ID)
          ?.page_index ?? null,
      setting: ask('SELECT value_json FROM settings WHERE key = ?', LEGACY_SETTING)?.value_json ?? null,
      // 升级之后才有的列：它在，说明旧库真的被迁移过，而不是原样放着没动。
      addedAtColumn:
        ask("SELECT COUNT(*) AS n FROM pragma_table_info('archives') WHERE name = 'added_at'")?.n ??
        null,
      localArchivesTable:
        ask("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'local_archives'")
          ?.n ?? null,
    };
  } finally {
    database.close();
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.make) {
    makeDatabase(resolve(options.make), options.upTo);
  } else if (options.inspect) {
    console.log(JSON.stringify(inspectDatabase(resolve(options.inspect)), null, 2));
  } else {
    throw new Error('要么 --make <out> 要么 --inspect <db>');
  }
} catch (error) {
  console.error(`旧库夹具失败：${error.message}`);
  process.exit(1);
}
