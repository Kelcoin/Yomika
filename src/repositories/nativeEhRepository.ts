import { z } from 'zod';
import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';
import { EhAccountSchema, EhAccountStatusSchema, type EhAccount, type EhAccountStatus, type SaveEhAccountInput } from '../domain/eh';

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

const EhCommentSchema = z.object({
  id: z.string().min(1),
  author: z.string(),
  body: z.string(),
  score: z.number().int(),
  postedAt: z.string(),
  isUploader: z.boolean(),
  isEditable: z.boolean(),
  myVote: z.number().int(),
});

export type EhSearchBridgeParams = { category?: number; page?: number };

export class NativeEhRepository {
  saveAccount(input: SaveEhAccountInput): Promise<CommandResult<EhAccount>> {
    return invokeCommand('save_eh_account', { input }, EhAccountSchema);
  }
  /** Signs in and returns the cookie string to store; saves nothing itself. */
  loginWithPassword(username: string, password: string): Promise<CommandResult<string>> {
    return invokeCommand('login_eh_account', { username, password }, z.string().min(1));
  }
  /** Opens E-Hentai's own sign-in page in a window of its own. A Cloudflare
   * challenge is a browser check, so no POST from here can answer it. */
  openLoginWindow(): Promise<CommandResult<void>> {
    return invokeCommand('open_eh_login_window', {}, VoidResponseSchema);
  }
  /** The cookie header once that window has one, `null` while it does not. */
  captureLoginCookies(): Promise<CommandResult<string | null>> {
    return invokeCommand('capture_eh_login_cookies', {}, z.string().min(1).nullable());
  }
  closeLoginWindow(): Promise<CommandResult<void>> {
    return invokeCommand('close_eh_login_window', {}, VoidResponseSchema);
  }
  listAccounts(): Promise<CommandResult<EhAccount[]>> {
    return invokeCommand('list_eh_accounts', {}, z.array(EhAccountSchema));
  }
  readAccountCookie(accountId: string): Promise<CommandResult<string>> {
    return invokeCommand('read_eh_account_cookie', { accountId }, z.string().min(1));
  }
  removeAccount(accountId: string): Promise<CommandResult<void>> {
    return invokeCommand('remove_eh_account', { accountId }, VoidResponseSchema);
  }
  searchGalleries(accountId: string, query: string, params?: EhSearchBridgeParams): Promise<CommandResult<z.infer<typeof EhSearchResponseSchema>>> {
    return invokeCommand('search_eh_galleries', { accountId, query, params: params ?? {} }, EhSearchResponseSchema);
  }
  removeFavorite(accountId: string, galleryId: string, token: string): Promise<CommandResult<void>> {
    return invokeCommand('remove_eh_favorite', { accountId, galleryId, token }, VoidResponseSchema);
  }
  voteComment(accountId: string, galleryId: string, token: string, commentId: string, vote: number): Promise<CommandResult<void>> {
    return invokeCommand('vote_eh_comment', { accountId, galleryId, token, commentId, vote }, VoidResponseSchema);
  }
  getComments(accountId: string, galleryId: string, token: string): Promise<CommandResult<z.infer<typeof EhCommentSchema>[]>> {
    return invokeCommand('get_eh_comments', { accountId, galleryId, token }, z.array(EhCommentSchema));
  }
  postComment(accountId: string, galleryId: string, token: string, body: string): Promise<CommandResult<void>> {
    return invokeCommand('post_eh_comment', { accountId, galleryId, token, body }, VoidResponseSchema);
  }
  checkLoginHealth(accountId: string): Promise<CommandResult<EhAccountStatus>> {
    return invokeCommand('check_eh_login_health', { accountId }, EhAccountStatusSchema);
  }
  setActiveAccount(accountId: string): Promise<CommandResult<void>> {
    return invokeCommand('set_active_eh_account', { accountId }, VoidResponseSchema);
  }
}
