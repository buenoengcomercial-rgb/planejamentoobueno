// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { editMeasuredRow, newMeasuredRow, addMeasuredPeriod } from './measurementWorkspace';
import { measurementEntryPatch } from './measurementEntryPatch';
import { encodeMeasurementWorkspace, decodeMeasurementWorkspace } from './measurementCloudCodec';
import { cloudMeasurementRepository } from './measurementCloudRepository';
import type { PendingMeasurementSave } from './measurementWorkspaceStore';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),download:vi.fn(),upload:vi.fn(),pending:null as PendingMeasurementSave|null,eventRevision:null as number|null,remoteRevision:0,missingVersion:false}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc,from:mocks.from,storage:{from:()=>({download:mocks.download,upload:mocks.upload})}}}));
vi.mock('./measurementWorkspaceStore',()=>({measurementRepository:()=>({preservePending:async(p:PendingMeasurementSave)=>{mocks.pending=structuredClone(p);},removePending:async()=>{mocks.pending=null;}})}));
beforeEach(()=>{vi.clearAllMocks();mocks.pending=null;mocks.eventRevision=null;mocks.remoteRevision=0;mocks.missingVersion=false;
 mocks.from.mockImplementation((table:string)=>({select:()=>({eq:()=>({
   eq:()=>({maybeSingle:async()=>({data:mocks.eventRevision===null?null:{revision:mocks.eventRevision},error:null})}),
   maybeSingle:async()=>({data:table==='measurement_workspace_versions'&&!mocks.missingVersion?{revision:mocks.remoteRevision}:null,error:null}),
 })})}));
});
describe('confirmação cloud e recuperação',()=>{
 it('envia somente os lançamentos afetados, conserva a base e exige recibo íntegro',async()=>{
  const f=measurementFixture(); f.plans=[]; const base=prepareIncorporation(await createIncorporationBackup(f.project,[],[])).candidate;
  const repo=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(base),error:null}); await repo.load();
  const next=editMeasuredRow(base,{id:'user',name:'Teste',canEdit:true},'m1','signs',{...newMeasuredRow('row'),multiplier:29});
  const patch=measurementEntryPatch(base,next)!;
  mocks.rpc.mockResolvedValueOnce({data:{projectId:base.projectId,revision:next.revision,patch:{event:patch.event,entries:patch.entries}},error:null});
  expect(await repo.commit(next,base.revision)).toEqual(next);
  expect(mocks.rpc).toHaveBeenLastCalledWith('patch_measurement_entries',{p_project_id:base.projectId,p_expected_revision:base.revision,p_patch:patch});
  const later=editMeasuredRow(next,{id:'user',name:'Teste',canEdit:true},'m1','signs',{...newMeasuredRow('row'),multiplier:30});
  mocks.rpc.mockResolvedValueOnce({data:{projectId:base.projectId,revision:later.revision,patch},error:null});
  await expect(repo.commit(later,next.revision)).rejects.toThrow('não confirmou'); expect(mocks.pending).not.toBeNull();
  expect(measurementEntryPatch(next,addMeasuredPeriod(next,{id:'user',name:'Teste',canEdit:true}))).toBeNull();
 });
 it('não baixa novamente arquivos imutáveis após cada confirmação e permite repetir download que falhou',async()=>{
  const f=measurementFixture(),base=prepareIncorporation(await createIncorporationBackup(f.project,f.plans,[])).candidate;
  base.plans[0].storagePath=`${base.projectId}/${base.plans[0].id}/drawing.png`;
  const repo=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValue({data:encodeMeasurementWorkspace(base),error:null});
  mocks.download.mockResolvedValueOnce({data:null,error:{message:'Falhou'}}).mockResolvedValue({data:base.plans[0].file,error:null});
  await expect(repo.load()).rejects.toThrow('Falhou'); await repo.load(); await repo.load();
  expect(mocks.download).toHaveBeenCalledTimes(2);
  const next=addMeasuredPeriod(base,{id:'user',name:'Teste',canEdit:true});
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(next),error:null}); await repo.commit(next,base.revision);
  expect(mocks.download).toHaveBeenCalledTimes(2);
 });
 it('carrega por RPC todas as 1.200 entradas, sem limite de página REST',async()=>{
  const f=measurementFixture(); f.plans=[];
  const base=prepareIncorporation(await createIncorporationBackup(f.project,[],[])).candidate;
  const service=base.services[0];
  base.services=Array.from({length:1200},(_,i)=>({...service,id:`service-${i}`,item:`1.${i+1}`}));
  base.entries=base.services.map((s,i)=>({projectId:base.projectId,measurementId:'m1',serviceId:s.id,rows:[{...newMeasuredRow(`row-${i}`),multiplier:i%10}]}));
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(base),error:null});
  const loaded=await cloudMeasurementRepository({userId:'user',projectId:base.projectId}).load();
  expect(loaded?.services).toHaveLength(1200); expect(loaded?.entries).toEqual(base.entries);
  expect(mocks.rpc).toHaveBeenCalledWith('load_measurement_workspace',{p_project_id:base.projectId});
 });
 it('falha ou resposta inválida mantém candidato; somente recibo válido limpa',async()=>{
  const f=measurementFixture(); f.plans=[]; const base=prepareIncorporation(await createIncorporationBackup(f.project,[],[])).candidate;
  const next=editMeasuredRow(base,{id:'user',name:'Teste',canEdit:true},'m1','signs',{...newMeasuredRow('row'),multiplier:29});
  const repo=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValueOnce({data:null,error:{message:'Sem conexão'}});
  await expect(repo.commit(next,0)).rejects.toThrow('Sem conexão'); expect(mocks.pending?.candidate).toEqual(next);
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(base),error:null});
  await expect(repo.commit(next,0)).rejects.toThrow('não confirmou'); expect(mocks.pending).not.toBeNull();
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(next),error:null});
  expect((await repo.commit(next,0)).revision).toBe(1); expect(mocks.pending).toBeNull();
 });
 it('timeout após commit é conciliado pelo ID da operação sem criar nova auditoria',async()=>{
  const f=measurementFixture(); f.plans=[]; const base=prepareIncorporation(await createIncorporationBackup(f.project,[],[])).candidate;
  const repo=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(base),error:null}); await repo.load();
  const next=editMeasuredRow(base,{id:'user',name:'Teste',canEdit:true},'m1','signs',{...newMeasuredRow('row'),multiplier:29});
  mocks.eventRevision=next.revision; mocks.remoteRevision=next.revision;
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'57014',message:'canceling statement due to statement timeout'}});
  expect(await repo.commit(next,base.revision)).toEqual(next);
  expect(mocks.rpc).toHaveBeenCalledTimes(2); expect(mocks.pending).toBeNull();
  expect(mocks.from).toHaveBeenCalledWith('measurement_workspace_events');
 });
 it('timeout abortado repete o mesmo patch uma vez; revisão concorrente mantém rascunho',async()=>{
  const f=measurementFixture(); f.plans=[]; const base=prepareIncorporation(await createIncorporationBackup(f.project,[],[])).candidate;
  const repo=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(base),error:null}); await repo.load();
  const next=editMeasuredRow(base,{id:'user',name:'Teste',canEdit:true},'m1','signs',{...newMeasuredRow('row'),multiplier:29});
  const patch=measurementEntryPatch(base,next)!;
  mocks.remoteRevision=base.revision;
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'57014',message:'statement timeout'}})
    .mockResolvedValueOnce({data:{projectId:base.projectId,revision:next.revision,patch},error:null});
  expect(await repo.commit(next,base.revision)).toEqual(next);
  expect(mocks.rpc.mock.calls.slice(-2).map(call=>call[1])).toEqual([
   {p_project_id:base.projectId,p_expected_revision:base.revision,p_patch:patch},
   {p_project_id:base.projectId,p_expected_revision:base.revision,p_patch:patch},
  ]);
  mocks.remoteRevision=next.revision+1;
  const later=editMeasuredRow(next,{id:'user',name:'Teste',canEdit:true},'m1','signs',{...newMeasuredRow('row'),multiplier:30});
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'57014',message:'statement timeout'}});
  await expect(repo.commit(later,next.revision)).rejects.toThrow('mudou durante');
  expect(mocks.pending?.candidate.audit.at(-1)?.id).toBe(later.audit.at(-1)?.id);
 });
 it('timeout sem linha de versão não interpreta ausência como revisão zero',async()=>{
  const f=measurementFixture(); f.plans=[]; const base=prepareIncorporation(await createIncorporationBackup(f.project,[],[])).candidate;
  const repo=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(base),error:null}); await repo.load();
  const next=editMeasuredRow(base,{id:'user',name:'Teste',canEdit:true},'m1','signs',{...newMeasuredRow('row'),multiplier:29});
  mocks.missingVersion=true;
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'57014',message:'statement timeout'}});
  await expect(repo.commit(next,base.revision)).rejects.toThrow('Não foi possível conferir a revisão');
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  expect(mocks.pending?.candidate.audit.at(-1)?.id).toBe(next.audit.at(-1)?.id);
 });
 it('carga parcial e arquivos de outra obra nunca são adotados',async()=>{
  const f=measurementFixture(),base=prepareIncorporation(await createIncorporationBackup(f.project,f.plans,[])).candidate;
  const raw=encodeMeasurementWorkspace(base) as Record<string,unknown>; delete raw.entries;
  await expect(decodeMeasurementWorkspace(raw,base.projectId,mocks.download)).rejects.toThrow('incompleta');
  base.plans[0].storagePath='outra-obra/planta/arquivo.png';
  await expect(decodeMeasurementWorkspace(encodeMeasurementWorkspace(base),base.projectId,mocks.download)).rejects.toThrow('vínculo'); expect(mocks.download).not.toHaveBeenCalled();
 });
});
