import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';

const repository = new NativeLibraryRepository();

/** Ids already confirmed this session, so switching back to a shelf does not
 * re-ask the server about the same archives. */
const checked = new Set<string>();
const missing = new Set<string>();

/** Keep in step with `VERIFY_ARCHIVE_LIMIT` in src-tauri/src/commands/library.rs:
 * one call checks at most this many. */
const VERIFY_BATCH = 64;

/** How many ids one visit may ask about.
 *
 * Each id costs one request, and a shelf can hold hundreds, so a visit cannot
 * check all of them. What makes that acceptable is that the answers are
 * remembered for the session: the next visit starts on the ones this one did not
 * reach, so a long shelf converges over a few visits instead of re-asking the same
 * first page forever. The complete answer comes from `refresh_archives`, which
 * walks the whole library in pages and then cleans out the records in one go. */
const VERIFY_BUDGET = 192;

/** Drops archives that no longer exist on the server from what a shelf is about
 * to show.
 *
 * The shelves resolve their ids against the local mirror, and the mirror only
 * learns about a deletion when something asks the server. Nothing refreshes it on
 * its own now that the library list pages from the server, so an archive deleted
 * elsewhere stayed on the shelves until the user clicked it and was told it does
 * not exist.
 *
 * Returns the ids that are gone. The native side does the rest of the cleanup as
 * part of the same call: it tombstones the archive in the local index, and deletes
 * the history/待看/收藏夹 records that pointed at it — writing sync tombstones, so
 * other devices drop them too. Only a definite 400/404 counts: a network failure
 * returns nothing and removes nothing.
 */
export async function findMissingArchives(
  serverId: string,
  archiveIds: readonly string[],
): Promise<Set<string>> {
  if (!serverId) return new Set();
  const unique = [...new Set(archiveIds)].filter(Boolean);
  const key = (id: string) => `${serverId}:${id}`;
  const knownMissing = new Set(unique.filter((id) => missing.has(key(id))));
  const unchecked = unique
    .filter((id) => !checked.has(key(id)) && !missing.has(key(id)))
    .slice(0, VERIFY_BUDGET);
  for (let at = 0; at < unchecked.length; at += VERIFY_BATCH) {
    const batch = unchecked.slice(at, at + VERIFY_BATCH);
    const result = await repository.verifyArchivesExist(serverId, batch);
    // A failure stops here rather than skipping the batch: an id that was never
    // looked at must not be remembered as checked.
    if (!result.ok) break;
    for (const id of batch) checked.add(key(id));
    for (const id of result.value) {
      missing.add(key(id));
      knownMissing.add(id);
    }
  }
  return knownMissing;
}

export function resetArchiveExistenceForTests(): void {
  checked.clear();
  missing.clear();
}
