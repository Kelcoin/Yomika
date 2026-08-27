import { z } from 'zod';
import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';
import { EhAccountSchema, type EhAccount, type SaveEhAccountInput } from '../domain/eh';

const EhSearchResultSchema = z.object({
  galleryKey: z.string(),
  url: z.string(),
  title: z.string(),
  category: z.string(),
  uploader: z.string(),
  pageCount: z.number(),
  tags: z.array(z.string()),
});

const EhSearchResponseSchema = z.object({
  galleries: z.array(EhSearchResultSchema),
});

export type EhSearchBridgeParams = { category?: number; page?: number };

export class NativeEhRepository {
  saveAccount(input: SaveEhAccountInput): Promise<CommandResult<EhAccount>> {
    return invokeCommand('save_eh_account', { input }, EhAccountSchema);
  }
  listAccounts(): Promise<CommandResult<EhAccount[]>> {
    return invokeCommand('list_eh_accounts', {}, z.array(EhAccountSchema));
  }
  searchGalleries(accountId: string, query: string, params?: EhSearchBridgeParams): Promise<CommandResult<z.infer<typeof EhSearchResponseSchema>>> {
    return invokeCommand('search_eh_galleries', { accountId, query, params: params ?? {} }, EhSearchResponseSchema);
  }
  removeFavorite(accountId: string, galleryId: string, token: string): Promise<CommandResult<void>> {
    return invokeCommand('remove_eh_favorite', { accountId, galleryId, token }, z.undefined());
  }
  voteComment(accountId: string, galleryId: string, token: string, commentId: string, vote: number): Promise<CommandResult<void>> {
    return invokeCommand('vote_eh_comment', { accountId, galleryId, token, commentId, vote }, z.undefined());
  }
  checkLoginHealth(accountId: string): Promise<CommandResult<{ loggedIn: boolean }>> {
    return invokeCommand('check_eh_login_health', { accountId }, z.object({ loggedIn: z.boolean() }));
  }
  setActiveAccount(accountId: string): Promise<CommandResult<void>> {
    return invokeCommand('set_active_eh_account', { accountId }, z.undefined());
  }
}
