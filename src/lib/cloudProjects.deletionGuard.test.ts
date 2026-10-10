import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { clearCloudSnapshot, confirmProjectCollectionsSnapshot } from './projectSync';
import { upsertCloudProject } from './cloudProjects';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), getUser: vi.fn(async () => ({ data: { user: { id: 'user' } } })) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from, auth: { getUser: mocks.getUser } } }));
const base = { id:'fictional',name:'Fictício',phases:[{id:'phase',name:'Capítulo',tasks:[{id:'task',name:'Vazia',percentComplete:0,dailyLogs:[]}]}] } as Project;
const deleted = () => ({ ...base,phases:[{...base.phases[0],tasks:[]}],auditLogs:[{id:'intent',entityType:'task',entityId:'task',action:'deleted',at:'2026-10-09T00:00:00Z',title:'Exclusão explícita'}] } as Project);
afterEach(() => { clearCloudSnapshot(base.id); vi.clearAllMocks(); });
describe('deletion preflight before any project write', () => {
  it('recovers a draft containing confirmed audit IDs without downloading or rewriting their payloads', async () => {
    confirmProjectCollectionsSnapshot(base,['eapChapters','tasks','taskDailyLogs'],{replaceExisting:true});
    const query = { select:vi.fn(),eq:vi.fn(),in:vi.fn(async()=>({data:[{id:'confirmed-before-reload'}],error:null})) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); mocks.from.mockReturnValue(query);
    mocks.rpc.mockResolvedValueOnce({data:'v2',error:null});
    const old = { id:'confirmed-before-reload',entityType:'task',entityId:'task',action:'updated',at:'2026-10-08',title:'Anterior' };
    const next = { ...base,phases:[{...base.phases[0],tasks:[{...base.phases[0].tasks[0],name:'Editada'}]}],auditLogs:[old,{...old,id:'pending-new'}] } as Project;
    expect(await upsertCloudProject(next,'org','v1')).toBe('v2');
    expect(query.select).toHaveBeenCalledWith('id');
    expect(mocks.rpc).toHaveBeenCalledWith('save_production_domain',expect.objectContaining({p_audit_insert:[expect.objectContaining({id:'pending-new'})]}));
  });
  it('blocks before the parent PATCH if server sees a reference the UI has not loaded', async () => {
    confirmProjectCollectionsSnapshot(base,['eapChapters','tasks','taskDailyLogs'],{replaceExisting:true});
    mocks.rpc.mockResolvedValueOnce({error:{code:'23514',message:'Vínculo protegido'}});
    await expect(upsertCloudProject(deleted(),'org','v1')).rejects.toMatchObject({code:'23514'});
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('check_production_deletions',expect.objectContaining({p_tasks_delete:['task'],p_expected_updated_at:'v1'}));
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('confirms the authoritative check, deletion and audit without loading other collections', async () => {
    confirmProjectCollectionsSnapshot(base,['eapChapters','tasks','taskDailyLogs'],{replaceExisting:true});
    mocks.rpc.mockResolvedValueOnce({data:true,error:null}).mockResolvedValueOnce({data:'v2',error:null});
    const query = { select:vi.fn(),eq:vi.fn(),in:vi.fn(async()=>({data:[],error:null})) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); mocks.from.mockReturnValue(query);
    expect(await upsertCloudProject(deleted(),'org','v1')).toBe('v2');
    expect(mocks.rpc.mock.calls.map(call=>call[0])).toEqual(['check_production_deletions','save_production_domain']);
    expect(mocks.from).toHaveBeenCalledWith('audit_logs');
  });
  it('an unloaded production collection never authorizes a deletion', async () => {
    confirmProjectCollectionsSnapshot(base,['eapChapters','tasks'],{replaceExisting:true});
    await expect(upsertCloudProject(deleted(),'org','v1')).rejects.toThrow('produção ainda não');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
