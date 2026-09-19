-- 本地档案的元数据：下载时就把标题、页数和标签抄一份下来，别等到要显示的时候再去
-- 借服务器镜像。镜像是一条 JOIN（archives 表里得正好有那一份、而且 is_deleted = 0），
-- 服务器换了、档案在服务器上被删了、或者压根没同步过这一份，本地就只剩文件名——
-- 一份已经躺在磁盘上的档案不该因为断网而变成「无标签的 zip」。
ALTER TABLE local_archives ADD COLUMN page_count INTEGER;
ALTER TABLE local_archives ADD COLUMN tags_json TEXT;
-- 取封面要用的 scope（本地镜像里那一列），存下来离线也认得出封面缓存。
ALTER TABLE local_archives ADD COLUMN scope_id TEXT;
