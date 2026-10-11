/** Whether the last server list read this session held any servers.
 *
 * 档案库与书架在知道「有没有服务器可谈」之前先画骨架，而这个答案来自一次 IPC，
 * 落在第一帧之后——所以一台服务器都没配时，每次切页都先闪一下空行，再换成
 * 「添加你的 LANraragi」引导。这个答案在一次运行里不会变，于是让第一个问过的
 * 页面把它记下来，后面挂载的页面直接从它起步。
 *
 * `undefined`＝还没读到过，也就是刚启动进程时的状态：那时候照旧先给骨架。
 *
 * 写的人只有仓库层，而且就写在学到这个答案的那次调用里（`list_servers`），以及
 * 会改变答案的几次调用里（`save_server`／`delete_server`／`set_server_enabled`）：
 * 刚加完或刚删完服务器就挂载的页面不能从一个过期的答案起步。读失败什么也没说，
 * 上一次的答案保持原样。
 */
let present: boolean | undefined;

export function readKnownServerPresence(): boolean | undefined {
  return present;
}

export function rememberServerPresence(next: boolean): void {
  present = next;
}

export function resetServerPresenceForTests(): void {
  present = undefined;
}
