-- 本地档案：下载到磁盘上的文件本身。任务表记的是「某次下载做过什么」，这里记的是
-- 「磁盘上现在有什么」，所以外部删掉一个文件之后，这一页读到的就是真相。
CREATE TABLE local_archives (
    path TEXT PRIMARY KEY NOT NULL,
    -- 文件名里带着 LANraragi 的档案 id（下载时由 archive_download_filename 写成），
    -- 认得出就能借本地镜像拿到标题、标签和封面；认不出就是一份普通的本地档案。
    archive_id TEXT,
    server_id TEXT,
    title TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX local_archives_archive_idx ON local_archives(archive_id);

-- 下载要能暂停、恢复、中止，任务行就得带上「文件在哪、收了多少、一共多少、多快」：
-- 这些状态原来只活在正在跑的那个 HTTP 请求里，进程一换就没了。
ALTER TABLE tasks ADD COLUMN archive_id TEXT;
ALTER TABLE tasks ADD COLUMN server_id TEXT;
-- 运行中是 `<最终名>.part`，完成后是发布出来的最终路径。
ALTER TABLE tasks ADD COLUMN local_path TEXT;
ALTER TABLE tasks ADD COLUMN total_bytes INTEGER;
ALTER TABLE tasks ADD COLUMN received_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN bytes_per_second INTEGER;
