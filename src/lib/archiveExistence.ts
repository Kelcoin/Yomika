import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';

const repository = new NativeLibraryRepository();

/** Ids already confirmed this session, so switching back to a shelf does not
 * re-ask the server about the same archives. */
const checked = new Set<string>();
const missing = new Set<string>();

/** Keep in step with `VERIFY_ARCHIVE_LIMIT` in src-tauri/src/commands/library.rs:
 * the native side checks at most this many per call, so asking about more would
 * mark ids as checked that were never looked at. */
const VERIFY_LIMIT = 32;

/** Drops archives that no longer exist on the server from what a shelf is about
 * to show.
 *
 * The shelves resolve their ids against the local mirror, and the mirror only
 * learns about a deletion when a full refresh runs or when something opens the
 * archive and gets a 404. Nothing refreshes it on its own now that the library
 * list pages from the server, so an archive deleted elsewhere stayed on the
 * shelves until the user clicked it and was told it does not exist.
 *
 * Returns the ids that are gone; they are tombstoned locally by the same call,
 * so the next visit never sees them. A network failure returns nothing: only a
 * definite answer from the server removes a card.
 */
export async function findMissingArchives(
  serverId: string,
  archiveIds: readonly string[],
): Promise<Set<string>> {
  if (!serverId) return new Set();
  const unique = [...new Set(archiveIds)].filter(Boolean);
  const knownMissing = new Set(unique.filter((id) => missing.has(`${serverId}:${id}`)));
  const unchecked = unique
    .filter((id) => !checked.has(`${serverId}:${id}`) && !missing.has(`${serverId}:${id}`))
    .slice(0, VERIFY_LIMIT);
  if (unchecked.length === 0) return knownMissing;
  const result = await repository.verifyArchivesExist(serverId, unchecked);
  if (!result.ok) return knownMissing;
  for (const id of unchecked) checked.add(`${serverId}:${id}`);
  for (const id of result.value) missing.add(`${serverId}:${id}`);
  for (const id of result.value) knownMissing.add(id);
  return knownMissing;
}

export function resetArchiveExistenceForTests(): void {
  checked.clear();
  missing.clear();
}
