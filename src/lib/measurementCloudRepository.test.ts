// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { editMeasuredRow, newMeasuredRow } from './measurementWorkspace';
import { encodeMeasurementWorkspace, decodeMeasurementWorkspace } from './measurementCloudCodec';
import { cloudMeasurementRepository } from './measurementCloudRepository';
import type { PendingMeasurementSave } from './measurementWorkspaceStore';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),download:vi.fn(),upload:vi.fn(),pending:null as PendingMeasurementSave|null}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc,storage:{from:()=>({download:mocks.download,upload:mocks.upload})}}}));
vi.mock('./measurementWorkspaceStore',()=>({measurementRepository:()=>({preservePending:async(p:PendingMeasurementSave)=>{mocks.pending=structuredClone(p);},removePending:async()=>{mocks.pending=null;}})}));
beforeEach(()=>{vi.clearAllMocks();mocks.pending=null;});
describe('confirmação cloud e recuperação',()=>{
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
 it('carga parcial e arquivos de outra obra nunca são adotados',async()=>{
  const f=measurementFixture(),base=prepareIncorporation(await createIncorporationBackup(f.project,f.plans,[])).candidate;
  const raw=encodeMeasurementWorkspace(base) as Record<string,unknown>; delete raw.entries;
  await expect(decodeMeasurementWorkspace(raw,base.projectId,mocks.download)).rejects.toThrow('incompleta');
  base.plans[0].storagePath='outra-obra/planta/arquivo.png';
  await expect(decodeMeasurementWorkspace(encodeMeasurementWorkspace(base),base.projectId,mocks.download)).rejects.toThrow('vínculo'); expect(mocks.download).not.toHaveBeenCalled();
 });
});
