# Yomika Bridge（LANraragi Script 插件）

插件可选安装。在同一个 LANraragi 实例上共享阅读进度、历史、待看、搜索预设和非重复标记；所有持有该实例 API 权限的客户端共享同一份数据，没有虚构的 profile 用户隔离。不修改档案、标签、分类或 LANraragi 原生阅读进度，也不会自动上传客户端旧数据。插件 1.1.0 的 `hello.capabilities.collections:true` 表示支持后两项；旧版插件需要替换文件并重启。

## 安装与升级

1. 先备份 LANraragi 配置 Redis 数据库（含持久化文件），记录当前插件文件校验和及版本。暂停桥接客户端写入后再做一致性备份。
2. 找到**运行中的 LANraragi 应用根目录**，将 `YomikaBridge.pm` 复制到 `<应用根目录>/lib/LANraragi/Plugin/Scripts/YomikaBridge.pm`，保持文件名、package 和目录一致。Windows 发行版为含 `lrr.conf`、`lib` 的发行版目录，**不是** `runtime/bin`；Docker 常见应用目录为 `/home/koyomi/lanraragi`，须以当前镜像实际工作目录为准，并将插件文件绑定挂载/纳入自建镜像，避免容器重建丢失。不要修改本机源码目录后误以为已安装至另一台服务器。
3. 重启 LANraragi。在插件列表确认 namespace 为 `yomikabridge`。已核对的当前上游通过启动扫描注册 `installed_path`，只往 Redis 手工添加插件名不能替代文件安装。此文件是非托管 Script package，不能原样当成 `Plugin/Managed/Scripts` 的 registry artifact 安装。
4. 在 Yomika 的服务器编辑页检测插件，再显式启用托管模式。启用不会迁移本地记录。先用测试档案验证跨客户端更新与离线冲突。

升级时暂停写入、备份、替换同路径文件、重启并检查 `hello`。不要删除 `YOMIKA_BRIDGE_V1:*` 键来“刷新插件”。卸载文件不会自动删除阅读数据。备份和恢复应保留整个命名空间，包括 operations 和 meta；只恢复部分数据会破坏幂等与版本关系。回滚到不兼容协议前应恢复匹配的完整备份。

## 历史增量刷新

插件 1.2.3 支持按服务器版本拉取变更。客户端拿到初始快照后，刷新只请求后续更新和删除记录。旧版插件仍可全量分页读取。

## 导入其他客户端的阅读历史

在插件页面开启并保存 `Include reading recorded by LANraragi or other clients in Yomika history`，并在 Yomika 对应服务器启用 Bridge 托管。Bridge 读取 LANraragi 服务端记录的 `lastreadtime` 和 `progress`。网页阅读时如启用了「仅在浏览器保存进度」，请改用服务端进度。如果服务器要求登录才能写入进度，请在网页登录后打开档案并翻一页。

可以在插件的请求框运行 `{"protocol":1,"action":"hello"}`，检查 `capabilities.importExternalHistory` 是否为 `true`。如果已启用但某一档案仍缺失，检查该档案在 LANraragi 的 `GET /api/archives/{id}/metadata` 返回的 `lastreadtime` 是否随翻页更新。

## 调用与协议

入口是 `POST /api/plugins/use?plugin=yomikabridge&arg=<经过百分号编码的 JSON>`；在部署子路径后使用相应 base URL。使用 LANraragi 标准 API 认证：`Authorization: Bearer <Base64(API key)>`。参数确实位于 query，不是 JSON body。密钥只交给客户端的安全凭据存储；不要将完整 URL、认证头或工作区内容打印到日志。

LANraragi 外层响应为 `{success,data,error,...}`；桥接数据在 `data`，失败时外层 `success:0`，`data.errorCode` 提供机器可读错误。成功响应带 `protocol:1,serverId,epoch,version`，其中 version 是整个桥接命名空间的版本，每次成功写入加一。serverId、epoch 是首次请求通过 Redis `HSETNX` 原子生成并持久保存的字符串；普通升级不变化。客户端发现身份变化应停止自动串联缓存。

请求都带 `{protocol:1,action:...}`：

| action | 附加参数 | 返回数据 |
| --- | --- | --- |
| hello | 无 | capabilities、limits、当前全局 version |
| states | ids（1–50 个档案 ID） | states，缺失记录返回 version/generation=0、其余字段 null |
| list | kind=`history`/`watchlist`, offset≥0, limit=1–100 | states、total；按最近修改顺序 |
| export | offset≥0, limit=1–100 | states、total；包括已清空的世代记录 |
| apply | operation，见下文 | state |
| workspace_get | key | workspace={key,version,value}，缺失为 version0/value null |
| workspace_put | key,expectedVersion,operationId,value | workspace，版本比较交换 |
| collection_list | collection,offset≥0,limit=1–50 | collection、records、total；包含删除墓碑，按 key 字典序分页 |
| collection_get | collection,key | record，缺失为 version0/value null/时间 null |
| collection_apply | operation={id,collection,key,expectedVersion,value} | record；冲突返回当前 record |

档案 ID 为小写 40 位十六进制；操作 ID、工作区 key 为 1–96 位 `[A-Za-z0-9_.:-]`。operation 为 `{id,archiveId,kind,expectedVersion,generation,progress?,allowProgressRegression?}`。kind 为 `progress`、`watchlist_add`、`watchlist_remove`、`history_delete`、`progress_clear`。

state 为 `{archiveId,version,generation,progress,historyAt,watchlistAt}`；progress 为 `{pageIndex,pageCount,layout,direction,coverAlone,updatedAt}`。pageIndex 从 0 开始且小于 pageCount（1–1000000）；layout=`paged`/`continuous`，direction=`ltr`/`rtl`，coverAlone 为 bool 或 null。null/省略保留已有偏好。服务器写入 UTC 时间；客户端传入 updatedAt 不可信且被忽略。默认禁止同世代页码回退；明确传 `allowProgressRegression:true` 才允许。

写进度同时更新历史；`(pageIndex+1)/pageCount > 0.9` 时原子移出待看，恰好 90% 保留。删除历史保留进度；清除进度同时删除历史并将 generation 加一，旧世代写入被拒绝。新增待看/写进度必须在档案库存在 file 字段；移除待看/删除历史/清除进度允许清理已删除档案的残留记录。跨数据库档案存在性检查是写入前检查，不能替代 LANraragi 自身的档案删除锁。

Redis Lua 对版本校验、状态/索引更新、全局版本、幂等结果做单次原子提交。冲突返回 `BRIDGE_CONFLICT` 和当前 state/workspace，客户端必须显示冲突并由用户决定后续操作。成功和冲突结果均永久保存，相同操作 ID 的重试返回**原始响应**，即使期间发生其他写入；相同 ID 配不同 payload 返回 `BRIDGE_OPERATION_REUSED`。档案不存在/格式错误等请求未提交，不进入结果账本。读取旧状态后计算的转换仍由 Lua CAS 阻止覆盖新状态。

workspace value 最大为 canonical JSON UTF-8 1800 字节。大查重结果应由调用方分块到 `dedup:<revision>:<chunk>`，最后用版本化 manifest 发布完整块列表；独立块不是跨块事务。保留任意 JSON 值与嵌套空数组。请求 JSON UTF-8 不得超过 6000 字节，百分号编码后的 arg 不得超过 5900 字节（为 URL 路径及 plugin 参数留余量）；非 ASCII/密集特殊字符需要更小分块。API 不自动遍历工作区 key，调用方应维护 manifest。

搜索预设和非重复标记使用独立记录集合，不使用上述 workspace 大文档或 1800 字节上限。`collection` 只能是 `search_presets` 或 `non_duplicates`。每条 record 为 `{collection,key,version,value,createdAt,updatedAt}`；首次写入 version1，删除 value=null 仍保留版本和服务器 UTC 时间，重建继续递增版本。每条 value canonical JSON UTF-8 最多 4000 字节，仍须满足请求的 URL 编码上限；集合没有总记录数上限。每页最多 50 条记录，响应规模受每条记录大小约束。

`search_presets` 的 key 为 1–96 位 token，value 必须恰好有 `{name,query,sortBy,sortOrder,categoryId}` 五个字段；name 非空白且最多 256 字符，query 为字符串，sortBy=`title`/`added`、sortOrder=`asc`/`desc`，categoryId 为 null 或最多 256 字符的字符串。客户端本地 scope/device/revision 不作为服务端业务内容。

`non_duplicates` 的 key 为两个不同档案 ID 按字典序组成的 `小ID:大ID`，value 为恰好两个字段 `{archiveIdA:小ID,archiveIdB:大ID}`。新增标记要求两个档案仍存在；删除 value=null 允许清理已删除档案的残留标记。幂等重试先查永久结果账本，因此成功标记后档案被删除仍可取回原始结果。读取和分页发现档案已删除时将标记转为墓碑，保留版本而不丢弃记录。

档案删除联动采用有界延迟清理：`states/list/export` 检查当前批次，非重复集合读取检查当前批次；`hello` 另以持久游标每次最多检查 20 条阅读记录和 20 条非重复标记，持续轮询会逐步覆盖全量。检查以档案 Redis 成功返回 `HEXISTS <id> file = 0` 为依据；空 file 字段仍视为存在，不检查磁盘文件是否可达。Redis 超时、异常或未定义结果不当作删除证据，整批收集完成前不会提交清理。

确认删除后清空进度/历史/待看、移除列表索引，并递增阅读 version 和 generation；相关非重复标记变为递增版本的墓碑。全局 version 随清理递增；旧离线世代即使档案重新导入也不能覆盖新状态。原始幂等响应永久保留，客户端收到旧操作重试结果后仍需重新读取当前状态。插件没有 LANraragi 删除 hook，不承诺删除完成瞬间同步清理；无桥接调用时不会自行运行。档案库与 configdb 的检查/提交不是跨数据库事务，删除后快速重新导入同一 ID 或并发写入仍可能需要下轮检查。列表清理可能缩短当前页；快照版本变化时应从第一页重新获取，不应将一次短页当作完整稳定快照。

集合写入与阅读写入共用全局 version 和 operation ID 命名空间，CAS、结果账本和索引原子提交。分页包含墓碑，total 也是含墓碑总数；不能用可见记录数计算下一页 offset。分页期间新增/删除或编辑可能使快照改变，完整拉取应校验各页 version 和结束 hello.version，不一致则重试；稳定 key 顺序避免纯编辑导致记录重排。独立记录避免两个不同预设或标记发生无关的整文档冲突。

## 持久化与备份

独立命名空间位于 LANraragi `get_redis_config` 指向的 configdb：

- `YOMIKA_BRIDGE_V1:meta`：身份、世代标识、全局版本。
- `...:states`、`...:records`、`...:history`、`...:watchlist`：状态与分页有序索引。
- `...:workspaces`：共享工作区块。
- `...:collection:search_presets`、`...:collection:non_duplicates`：各集合逐条记录与永久删除墓碑。
- `...:collection_index:search_presets`、`...:collection_index:non_duplicates`：包含墓碑的稳定 key 分页索引。
- `...:operations`：永久幂等结果，不设 TTL，随写入增长；当前版本不提供自动垃圾回收，避免延迟重试复活旧操作。

Redis 的 RDB/AOF 决定断电后的实际持久性；插件返回成功并不等于 AOF 已 fsync。按部署需要配置 AOF 和备份，确认 Docker Redis 数据卷或 Windows database 目录持久保存。备份整个 configdb 的 RDB/AOF 能保留 LANraragi 配置和桥接数据；使用 Redis 官方备份/恢复流程，并在隔离实例验证恢复，不能对生产实例运行 FLUSHDB。按 namespace 导出时应暂停桥接写入，使用 SCAN + DUMP/RESTORE 保留上述全部键，而不是只导出 states。`export` 是供客户端审阅的分页状态导出，不能替代 Redis 完整灾备，分页期间有写入可能移位，完整导出请暂停写入或校验首尾 hello.version 并重试。

## 验证与边界

纯 Perl 测试：`perl plugins/lanraragi/t/bridge.t`。实际 Lua 集成测试：在独立空白 Redis 实例启动后设置 `YOMIKA_TEST_REDIS_PORT=<本机测试端口>` 再运行同命令；测试只使用随机进程专属 `YOMIKA_BRIDGE_TEST:*`，不连接生产 LANraragi。测试客户端使用核心 IO::Socket，无需 Redis CPAN 模块；生产由 LANraragi 提供 Redis 依赖。

已在 Windows Git Perl 5.42.2 和独立 Redis 7.2.9 上实测转换、严格 >90%、世代、版本冲突、跨后续写入重试、分页索引、空数组、工作区 CAS、65 条集合分页、集合墓碑、非重复标记校验、档案删除后重试/清理、Unicode 字节限制。未在用户 LANraragi 实例安装或执行端到端部署验收。

详细调试范围、修复与残余部署限制见 [DEBUG_REPORT.md](DEBUG_REPORT.md)。

此版本没有 SSE、全库事件 hook、网页操作捕获、指纹/重型查重后台任务、封面生成队列或封面批量状态声明。hello 明确返回 `coverStatus:false,push:false`；客户端按前台恢复和版本轮询刷新。LANraragi 网页原生阅读进度不会自动进入这份独立桥接数据。

## 客户端更新与离线恢复

在服务器编辑菜单检测插件后开启“服务器托管用户数据”。已有本机记录不会自动迁移；开启前的本机记录作为恢复基线保存。服务器身份和 epoch 必须匹配，不能把另一个实例的记录混入当前队列。

客户端前台约每 30 秒探测版本，仅版本变化时刷新历史、待看、搜索预设和非重复标记；阅读写入合并约 10 秒提交，其他操作立即尝试提交，每轮最多 8 个。后台停止轮询，进入后台、恢复前台或网络恢复时尝试提交。网络失败指数退避，持久队列不丢弃；后台被系统直接杀死时不保证最后一次网络提交完成，但已入队操作可在下次启动恢复。

并发冲突不自动覆盖服务器记录。菜单中的采用服务器数据操作会丢弃对应冲突档案的本机待提交链，每次最多处理 50 本，可重复操作。如果服务器永久不可用，可显式选择“停用并恢复原本机数据”，确认后丢弃该范围全部待提交操作并恢复启用前本机基线；此操作不会删除服务器数据，托管期间产生的本机阅读修改也不会自动迁回。

通用 workspace 仍仅是高级协议接口。搜索预设和非重复标记的托管由专用 collections 接口完成；完整查重分析报告、指纹或运行状态不会上传到这些集合。

### 外部阅读历史

在 LANraragi 插件配置页打开 **Include reading recorded by LANraragi or other clients in Yomika history** 后，Yomika 的托管历史会导入 LANraragi 网页阅读器及其他客户端已保存到服务端的阅读时间和页码。开关默认关闭。关闭后停止导入，已导入的记录可以在历史页删除。Yomika 自己的阅读仍使用原有的托管写入流程。

读取历史首页时按批检查 LANraragi 的档案数据库。大型库可能需要刷新几次才能完成首次导入。只保存在浏览器或其他客户端本地的阅读记录无法读取。导入的页码用于历史显示，独立于 Yomika 的续读进度。

### 客户端边界

当前客户端单次完整集合快照最多读取 100,000 条记录（含墓碑），超过上限会明确报错并保留原缓存；插件集合本身没有此总量上限。列表分页期间版本变化会有界重试，不接受混合版本快照。已提交操作的重试回执保持原始结果，客户端另读当前服务器记录后更新镜像，避免旧回执复活已删除数据。

文件导入导出独立保留。托管开启时允许导出本机已缓存的数据，但该文件不是服务端完整灾备；导入五类记录需先关闭对应服务器的托管，避免绕过插件改写镜像。应用设置可独立导入。需要恢复插件完整数据应使用 Redis 完整备份。
