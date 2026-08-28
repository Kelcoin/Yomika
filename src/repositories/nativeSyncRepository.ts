import { z } from 'zod';

import { invokeCommand } from '../bridge/invoke';
import { SyncJournalRecordSchema, type SyncJournalRecord } from '../domain/library';
import {
  BuiltSyncSegmentSchema,
  SyncManifestSchema,
  WebdavAccountSchema,
  type BuiltSyncSegment,
  type SaveWebdavAccountInput,
  type SyncManifest,
  type WebdavAccount,
} from '../domain/syncWire';
import type { CommandResult } from '../domain/result';

export class NativeSyncRepository {
  createKey(accountId: string): Promise<CommandResult<string>> {
    return invokeCommand('create_sync_key', { accountId }, z.string().min(1));
  }

  buildSegment(accountId: string, scopeId: string): Promise<CommandResult<BuiltSyncSegment | null>> {
    return invokeCommand('build_sync_segment', { accountId, scopeId }, BuiltSyncSegmentSchema.nullable());
  }

  encryptManifest(accountId: string, manifest: SyncManifest): Promise<CommandResult<number[]>> {
    return invokeCommand('encrypt_sync_manifest', { accountId, manifest }, z.array(z.number().int().min(0).max(255)));
  }

  decryptManifest(accountId: string, ciphertext: number[]): Promise<CommandResult<SyncManifest>> {
    return invokeCommand('decrypt_sync_manifest', { accountId, ciphertext }, SyncManifestSchema);
  }

  mergeManifests(local: SyncManifest, remote: SyncManifest): Promise<CommandResult<SyncManifest>> {
    return invokeCommand('merge_sync_manifests', { local, remote }, SyncManifestSchema);
  }

  saveAccount(input: SaveWebdavAccountInput): Promise<CommandResult<WebdavAccount>> {
    return invokeCommand('save_webdav_account', { input }, WebdavAccountSchema);
  }

  listAccounts(): Promise<CommandResult<WebdavAccount[]>> {
    return invokeCommand('list_webdav_accounts', {}, z.array(WebdavAccountSchema));
  }

  claimJournal(scopeId: string, limit = 32): Promise<CommandResult<SyncJournalRecord[]>> {
    return invokeCommand('claim_sync_journal', { scopeId, limit }, z.array(SyncJournalRecordSchema));
  }

  syncWebdavScope(accountId: string, scopeId: string): Promise<CommandResult<number>> {
    return invokeCommand('sync_webdav_scope', { accountId, scopeId }, z.number().int().nonnegative());
  }
}
