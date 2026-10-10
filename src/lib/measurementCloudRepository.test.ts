// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { editMeasuredRow, newMeasuredRow, addMeasuredPeriod, freezeMeasuredPeriod } from './measurementWorkspace';
import { measurementEntryPatch } from './measurementEntryPatch';
import { encodeMeasurementWorkspace, decodeMeasurementWorkspace } from './measurementCloudCodec';
import { cloudMeasurementRepository } from './measurementCloudRepository';
import type { PendingMeasurementEntrySave, PendingMeasurementSave, StoredMeasurementPending } from './measurementWorkspaceStore';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),download:vi.fn(),upload:vi.fn(),pending:null as PendingMeasurementSave|null,compact:null as PendingMeasurementEntrySave|null,stored:[] as StoredMeasurementPending[],eventRevision:null as number|null,remoteRevision:0,missingVersion:false}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc,from:mocks.from,storage:{from:()=>({download:mocks.download,upload:mocks.upload})}}}));
vi.mock('./measurementWorkspaceStore',()=>({measurementRepository:()=>({
 preservePending:async(p:PendingMeasurementSave)=>{mocks.pending=structuredClone(p);mocks.stored=[...mocks.stored.filter(row=>!('candidate' in row)||row.candidate.audit.at(-1)?.id!==p.candidate.audit.at(-1)?.id),p];},
 preserveEntryPending:async(p:PendingMeasurementEntrySave)=>{mocks.compact=structuredClone(p);mocks.stored=[...mocks.stored.filter(row=>!('operationId' in row&&row.operationId===p.operationId)),p];},
 storedPendingSaves:async()=>structuredClone(mocks.stored),
 removeEntryPending:async(operationId:string)=>{mocks.compact=null;mocks.stored=mocks.stored.filter(row=>!('operationId' in row&&row.operationId===operationId));},
 removePending:async(operationId:string)=>{mocks.pending=null;mocks.compact=null;mocks.stored=mocks.stored.filter(row=>('operationId' in row?row.operationId:row.candidate.audit.at(-1)?.id)!==operationId);},
 archivePending:async(operationId:string)=>{mocks.stored=mocks.stored.map(row=>('operationId' in row?row.operationId:row.candidate.audit.at(-1)?.id)===operationId?{...row,archivedAt:'2026-10-10'}:row);},
 })}));
beforeEach(()=>{vi.clearAllMocks();mocks.pending=null;mocks.compact=null;mocks.stored=[];mocks.eventRevision=null;mocks.remoteRevision=0;mocks.missingVersion=false;
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
  await expect(repo.commit(later,next.revision)).rejects.toThrow('não confirmou'); expect(mocks.compact?.operationId).toBe(later.audit.at(-1)?.id);
  expect((await repo.pending())?.candidate.entries).toEqual(later.entries);
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
  expect(mocks.compact?.operationId).toBe(later.audit.at(-1)?.id);
  expect((await repo.pending())?.candidate.audit.at(-1)?.id).toBe(later.audit.at(-1)?.id);
 });
 it('envio fiscal completo concilia timeout após commit, repete se não gravou e preserva conflito',async()=>{
  const f=measurementFixture(); f.plans=[]; const base=prepareIncorporation(await createIncorporationBackup(f.project,[],[])).candidate;
  const actor={id:'user',name:'Teste',canEdit:true,canReview:true};
  const fiscal=freezeMeasuredPeriod(base,actor,'m1');
  const repo=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(base),error:null}); await repo.load();
  mocks.eventRevision=fiscal.revision; mocks.remoteRevision=fiscal.revision;
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'57014',message:'statement timeout'}});
  expect(await repo.commit(fiscal,base.revision)).toEqual(fiscal);
  expect(mocks.rpc).toHaveBeenLastCalledWith('commit_measurement_workspace',{
   p_project_id:base.projectId,p_expected_revision:base.revision,p_candidate:encodeMeasurementWorkspace(fiscal),
  });
  expect(await repo.pending()).toBeNull();

  const following=addMeasuredPeriod(fiscal,actor);
  mocks.eventRevision=null; mocks.remoteRevision=fiscal.revision;
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'57014',message:'statement timeout'}})
   .mockResolvedValueOnce({data:encodeMeasurementWorkspace(following),error:null});
  expect(await repo.commit(following,fiscal.revision)).toEqual(following);
  const retryCalls=mocks.rpc.mock.calls.slice(-2);
  expect(retryCalls[0]).toEqual(retryCalls[1]);
  expect(await repo.pending()).toBeNull();

  const concurrent=addMeasuredPeriod(following,actor);
  mocks.remoteRevision=following.revision+2;
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'57014',message:'statement timeout'}});
  await expect(repo.commit(concurrent,following.revision)).rejects.toThrow('mudou durante');
  expect((await repo.pending())?.candidate).toEqual(concurrent);
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
  expect(mocks.compact?.operationId).toBe(next.audit.at(-1)?.id);
  expect((await repo.pending())?.candidate.audit.at(-1)?.id).toBe(next.audit.at(-1)?.id);
 });
 it('recupera patch compacto após recarga e continua aceitando pending legado completo',async()=>{
  const f=measurementFixture(); f.plans=[]; const base=prepareIncorporation(await createIncorporationBackup(f.project,[],[])).candidate;
  const repo=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(base),error:null}); await repo.load();
  const next=editMeasuredRow(base,{id:'user',name:'Teste',canEdit:true},'m1','signs',{...newMeasuredRow('row'),multiplier:29});
  mocks.missingVersion=true;
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'57014',message:'statement timeout'}});
  await expect(repo.commit(next,base.revision)).rejects.toThrow();
  expect(mocks.compact).toMatchObject({format:'entry-patch-v1',baseRevision:base.revision,operationId:next.audit.at(-1)?.id});
  expect('candidate' in mocks.stored[0]).toBe(false);
  expect(JSON.stringify(mocks.compact).length).toBeLessThan(JSON.stringify(next).length / 2);
  mocks.missingVersion=false;
  const reloaded=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(base),error:null});
  const [remote,pending]=await Promise.all([reloaded.load(),reloaded.pending()]);
  expect(remote?.revision).toBe(base.revision);
  expect(pending?.candidate.entries).toEqual(next.entries);
  expect(pending?.candidate.audit.at(-1)?.id).toBe(next.audit.at(-1)?.id);
  expect(pending?.compact?.patch).toEqual(mocks.compact?.patch);
  expect(mocks.rpc).toHaveBeenCalledTimes(3); // One shared reload request.
  const patch=measurementEntryPatch(base,next)!;
  mocks.rpc.mockResolvedValueOnce({data:{projectId:base.projectId,revision:next.revision,patch},error:null});
  expect((await reloaded.commit(pending!.candidate,base.revision)).entries).toEqual(next.entries);
  expect(await reloaded.pending()).toBeNull();
  mocks.stored=[{baseRevision:base.revision,candidate:next}];
  expect((await reloaded.pending())?.candidate).toEqual(next);
 });
 it('retry de pending legado limpa cópias legada e compacta do mesmo ID sem apagar outros IDs',async()=>{
  const f=measurementFixture(); f.plans=[]; const base=prepareIncorporation(await createIncorporationBackup(f.project,[],[])).candidate;
  const next=editMeasuredRow(base,{id:'user',name:'Teste',canEdit:true},'m1','signs',{...newMeasuredRow('row'),multiplier:29});
  const operationId=next.audit.at(-1)!.id;
  const archived={baseRevision:base.revision,candidate:{...next,audit:[...next.audit.slice(0,-1),{...next.audit.at(-1)!,id:'other-operation'}]},archivedAt:'2026-10-10'};
  mocks.stored=[{baseRevision:base.revision,candidate:next},archived];
  const repo=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(base),error:null});
  await repo.load();
  const legacy=await repo.pending();
  expect(legacy?.candidate.audit.at(-1)?.id).toBe(operationId);
  const patch=measurementEntryPatch(base,next)!;
  mocks.rpc.mockResolvedValueOnce({data:{projectId:base.projectId,revision:next.revision,patch},error:null});
  await repo.commit(legacy!.candidate,legacy!.baseRevision);
  expect(mocks.stored.map(row=>('operationId' in row?row.operationId:row.candidate.audit.at(-1)?.id))).toEqual(['other-operation']);
  expect(await repo.pending()).toBeNull();
  const reloaded=cloudMeasurementRepository({userId:'user',projectId:base.projectId});
  mocks.rpc.mockResolvedValueOnce({data:encodeMeasurementWorkspace(next),error:null});
  await reloaded.load();
  expect(await reloaded.pending()).toBeNull();
  expect((await reloaded.pendingSaves()).map(row=>row.candidate.audit.at(-1)?.id)).toEqual(['other-operation']);
 });
 it('carga parcial e arquivos de outra obra nunca são adotados',async()=>{
  const f=measurementFixture(),base=prepareIncorporation(await createIncorporationBackup(f.project,f.plans,[])).candidate;
  const raw=encodeMeasurementWorkspace(base) as Record<string,unknown>; delete raw.entries;
  await expect(decodeMeasurementWorkspace(raw,base.projectId,mocks.download)).rejects.toThrow('incompleta');
  base.plans[0].storagePath='outra-obra/planta/arquivo.png';
  await expect(decodeMeasurementWorkspace(encodeMeasurementWorkspace(base),base.projectId,mocks.download)).rejects.toThrow('vínculo'); expect(mocks.download).not.toHaveBeenCalled();
 });
});
