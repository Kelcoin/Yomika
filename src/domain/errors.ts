import { z } from 'zod';

export const DomainErrorCodeSchema = z.enum([
  'UNKNOWN',
  'INVALID_RESPONSE',
  'INVALID_INPUT',
  'INVALID_MANIFEST',
  'INVALID_MODEL_IMPORT',
  'MODEL_MANIFEST_FETCH_FAILED',
  'MODEL_ALREADY_EXISTS',
  'MODEL_DOWNLOAD_FAILED',
  'MODEL_ACTIVATION_FAILED',
  'PLATFORM_UNAVAILABLE',
  'LRR_UNAUTHORIZED',
  'LRR_NOT_FOUND',
  'REMOTE_CONFLICT',
  'REMOTE_RATE_LIMIT',
  'REMOTE_UNAVAILABLE',
  'SYNC_MANIFEST_CONFLICT',
  'INFERENCE_UNAVAILABLE',
  /** 这一页的推理被取消了（切页、关开关、离开阅读器）。不是失败：取消的结果既
   * 不该进错误日志，也不该写进任何缓存。 */
  'INFERENCE_CANCELLED',
  /** 远端那一台超时没回话：可重试，本地会退到本机那一版继续读。 */
  'REMOTE_TIMEOUT',
  'CACHE_QUOTA_EXCEEDED',
  'EH_UNAUTHORIZED',
  /** A sign-in attempt was refused. Distinct from EH_REAUTH_REQUIRED, which
   * means a stored session stopped working: telling someone their login had
   * expired on their first attempt is a contradiction. */
  'EH_LOGIN_REJECTED',
  // The sign-in window was closed before a session appeared, which is how
  // someone gives up on the web login.
  'EH_LOGIN_WINDOW_CLOSED',
  'EH_REAUTH_REQUIRED',
  'EH_RATE_LIMIT',
  'EH_CLOUDFLARE',
  'EH_ACCESS_BLOCKED',
  'EH_CONTENT_WARNING',
  'EH_GALLERY_DELETED',
  'EH_GALLERY_COPYRIGHT_REMOVED',
  'EH_EMPTY_RESPONSE',
  'EH_UNEXPECTED_PAGE',
  'EH_UNAVAILABLE',
  /** 原生侧已经在用的几个码，之前没进这张表：任何一处发出它们，整条错误都会被桥
   * 当成「无效响应」，真正的信息（比如 WebDAV 连不上）反而看不到。 */
  'NETWORK',
  'NOT_FOUND',
  'LOCAL_DATABASE',
  /** 模型仓库那份目录拿不到（离线、镜像挂了）。目录只在设置页用，拿不到就该显示
   * 「列不出来」，而不是把所有模型列表一起弄空。 */
  'MODEL_CATALOG_FETCH_FAILED',
  /** 本体更新检查（`app_release_latest`）：请求本身没走通，或者答复不是能用的
   * release 负载。调用方按「这次查不出来」处理，不打扰用户。 */
  'APP_RELEASE_CHECK_FAILED',
  /** GitHub 那边没回话/超时。分开记是因为这一个值得过一会儿再试，前者通常是
   * 我们的解析或网络配置的问题。 */
  'APP_RELEASE_UNREACHABLE',
  /** 重计算（宿主编排 + 独立 worker 进程）那一路的码，见 docs/71 §6.6。
   *
   * 这张表是闭集，桥接拿它校验**整条**错误信封：没登记过的码不是「原样透传」，而是
   * 整条被判成 `INVALID_RESPONSE`——真正的理由（worker 起不来、GPU 拿不到、排队满）
   * 反而看不见。所以宿主会发的每一个码都必须在这里有一行；上面 NETWORK 那几行的
   * 注释说的就是同一个坑。
   */
  'COMPUTE_WORKER_UNAVAILABLE',
  'COMPUTE_PROTOCOL_MISMATCH',
  'COMPUTE_WORKER_LOST',
  /** 同一个 worker 同时只伺候一个重任务：它正忙的时候第二份提交会被拒。 */
  'COMPUTE_WORKER_BUSY',
  'COMPUTE_QUEUE_FULL',
  'COMPUTE_RESOURCE_LIMIT',
  'COMPUTE_TIMEOUT',
  'GPU_OUTPUT_INVALID',
  'GPU_BACKEND_UNAVAILABLE',
  'COMPUTE_ARTIFACT_INVALID',
  'COMPUTE_ARTIFACT_REJECTED',
  /** 交给 worker 的那份只读输入读不到、或者内容和声明对不上：这次运行没开始算就作废。 */
  'COMPUTE_INPUT_INVALID',
  /** 这一段要的模型在这台机器上没有可用的那份（没下载、没装完、安装目录有歧义）。 */
  'COMPUTE_MODEL_UNAVAILABLE',
  'COMPUTE_CANCELLED',
  'COMPUTE_INTERNAL',
  'COMPUTE_BAD_REQUEST',
  /** 编排没起来（worker 可执行文件不在、控制线程起不来）：现在算不了，但这不是崩溃。 */
  'COMPUTE_UNAVAILABLE',
  /** 图片租借：URL 只认租借号，这三种都是「这张图现在取不了」。 */
  'COMPUTE_LEASE_UNKNOWN',
  'COMPUTE_LEASE_EXPIRED',
  'COMPUTE_LEASE_WRONG_WINDOW',
]);

export type DomainErrorCode = z.infer<typeof DomainErrorCodeSchema>;

/** 这些码说的是「你看到的那个东西现在就是这样」，不是「哪里坏了」：调用方照样按失败
 * 处理（该分支的分支、该提示的提示），只是不往设置页那份错误日志里记——日志是给人查
 * 现场的，塞满正常状态就等于把现场埋了。
 *
 * - `LRR_NOT_FOUND`：档案已经从 LANraragi 上移除了，本地索引清掉就行。档案详情页本来
 *   就会说「该档案已从 LANraragi 移除，本地索引已清理」。
 * - `INFERENCE_CANCELLED` / `COMPUTE_CANCELLED`：取消是这一页这一档的结果，不是失败
 *   （`INFERENCE_CANCELLED` 上面那条注释早就写着「取消的结果既不该进错误日志」）。 */
export const QUIET_ERROR_CODES: ReadonlySet<string> = new Set(['LRR_NOT_FOUND', 'INFERENCE_CANCELLED', 'COMPUTE_CANCELLED']);

export interface DomainError {
  code: DomainErrorCode;
  message: string;
  retryable: boolean;
}

export const DomainErrorSchema: z.ZodType<DomainError> = z.object({
  code: DomainErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
