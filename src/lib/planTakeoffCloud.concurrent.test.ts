import { beforeEach, expect, it, vi } from 'vitest';
import { updateCloudPlan } from './planTakeoffCloud';
import type { TakeoffPlan } from './planTakeoff';
const mocks=vi.hoisted(()=>({from:vi.fn(),update:vi.fn(),responses:[] as unknown[]}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:mocks.from}}));
beforeEach(()=>{
  vi.clearAllMocks(); mocks.responses=[];
  mocks.from.mockImplementation(()=>{
    const query={update:mocks.update,select:vi.fn(),eq:vi.fn(),is:vi.fn(),maybeSingle:vi.fn(async()=>mocks.responses.shift())};
    for(const fn of [query.update,query.select,query.eq,query.is]) fn.mockReturnValue(query);
    return query;
  });
});
const scope={organizationId:'org',userId:'user',projectId:'project'};
const plan=():TakeoffPlan=>({id:'p',name:'Original',floor:'Térreo',kind:'image',scales:{1:1},measures:[],file:new Blob(['image']),storagePath:'path',cloudRevision:1});
it('envia só o campo alterado, reconciliando outro campo remoto',async()=>{
  const before=plan(), next={...before,name:'Local'};
  mocks.responses=[{data:null,error:null},{data:{id:'p',name:'Original',floor:'Superior',kind:'image',scales:{1:1},measures:[],chapter_id:null,building:null,file_path:'path',revision:2},error:null},
    {data:{revision:3},error:null}];
  await updateCloudPlan(scope,next,before);
  expect(mocks.update.mock.calls[0][0]).toEqual({name:'Local',revision:2});
  expect(mocks.update.mock.calls[1][0]).toEqual({name:'Local',revision:3});
  expect(next).toMatchObject({name:'Local',floor:'Superior',cloudRevision:3});
});
it('não sobrescreve o primeiro nome confirmado nem apaga a tentativa local',async()=>{
  const before=plan(), next={...before,name:'Tentativa'};
  mocks.responses=[{data:null,error:null},{data:{id:'p',name:'Primeiro',floor:'Térreo',kind:'image',scales:{1:1},measures:[],chapter_id:null,building:null,file_path:'path',revision:2},error:null}];
  await expect(updateCloudPlan(scope,next,before)).rejects.toThrow('primeira');
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(next.name).toBe('Tentativa');
});
