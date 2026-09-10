import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeduplicationWorkspace } from '../../src/components/DeduplicationWorkspace';
import { ToastProvider } from '../../src/components/Toast';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { setInvokeAdapterForTests, resetInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);
describe('duplicate deletion confirmation', () => {
  it('confirms favorite synchronization and reports failed archive outcomes', async () => {
    const user = userEvent.setup();
    const pair = { leftArchiveId:'a',rightArchiveId:'b',source:'filename' };
    const session = {sessionId:'scan',scopeId:'scope',algorithmVersion:'v1',status:'completed',checkpoint:2,archiveCount:2};
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return {ok:true,value:{...DEFAULT_PREFERENCES,ehFavoriteDeleteSync:true}};
      if (command === 'list_servers') return {ok:true,value:[{id:'s',scopeId:'scope',name:'Server',baseUrl:'https://lrr.test'}]};
      if (command === 'list_archives') return {ok:true,value:[]};
      if (command === 'dedup_scan') return {ok:true,value:{...session,stage:'completed',processed:2,total:2,cacheHits:0,downloads:0,missingCovers:0,invalidCovers:0,pairCount:1,degraded:false,diagnostics:[],pairs:[pair]}};
      if (command === 'dedup_load_result') return {ok:true,value:{session,archives:[],pairs:[pair],selectedArchiveIds:['a'],outcomes:[]}};
      if (command === 'dedup_delete_selected') return {ok:true,value:{rejectedArchiveIds:[],outcomes:[{archiveId:'a',deleted:false,message:'收藏同步失败'}]}};
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button',{name:'开始扫描'})).toBeEnabled());
    await user.click(screen.getByRole('button',{name:'开始扫描'}));
    await user.click(await screen.findByRole('button',{name:'删除所选'}));
    expect(screen.getByRole('dialog',{name:'确认删除'})).toHaveClass('dialog-content');
    expect(await screen.findByRole('switch',{name:'本次同步删除 E-Hentai 收藏'})).toHaveAttribute('aria-checked','true');
    expect(adapter.mock.calls.some(([command])=>command === 'dedup_delete_selected')).toBe(false);
    await user.click(screen.getByRole('button',{name:'确认删除'}));
    await waitFor(()=>expect(adapter).toHaveBeenCalledWith('dedup_delete_selected',{input:{sessionId:'scan',outcomes:[]},syncFavorite:true}));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 个档案未删除：收藏同步失败');
  });
});
