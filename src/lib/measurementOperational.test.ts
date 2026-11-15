import { describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { editMeasuredRow, newMeasuredRow, type MeasurementWorkspace } from './measurementWorkspace';
import { applyMeasurementOperationReceipt, fromOperationalWorkspace, measurementOperation, toOperationalWorkspace } from './measurementOperational';
import { decodeMeasurementWorkspace } from './measurementCloudCodec';

async function fixture(): Promise<MeasurementWorkspace> {
  const f=measurementFixture(); f.plans=[];
  const legacy=prepareIncorporation(await createIncorporationBackup(f.project,f.plans,[])).candidate;
  return {...legacy,revision:legacy.revision+1,audit:[],operational:{version:2,cutoffRevision:legacy.revision,
    fiscal:Object.fromEntries(legacy.periods.map(p=>[p.id,{changedSinceSubmission:false}]))}};
}
const actor={id:'user',name:'Teste',canEdit:true};
describe('formato operacional sem auditoria',()=>{
  it('grava e reabre o formato v2 sem inventar histórico legado nem omitir cálculos',async()=>{
    const base=await fixture(); const wire=toOperationalWorkspace(base);
    expect(wire.schema).toBe(2); expect(wire).not.toHaveProperty('audit');
    expect(await decodeMeasurementWorkspace(wire,base.projectId)).toEqual(base);
    expect(fromOperationalWorkspace(wire)).toEqual(base);
    const candidate=editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('pending'));
    expect(()=>toOperationalWorkspace(candidate)).toThrow('confirmada');
    expect(()=>fromOperationalWorkspace({...wire,operational:{...wire.operational,fiscal:{}}})).toThrow('fiscal');
  });
  it('isola o comando original e aplica apenas os registros do recibo válido',async()=>{
    const base=await fixture(), next=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('changed'),multiplier:3});
    const command=measurementOperation(base,next);
    expect(command.changes.services).toBeUndefined(); expect(command.changes.plans).toBeUndefined();
    expect(JSON.stringify(command)).not.toContain('beforeServices');
    const receipt={format:2 as const,projectId:base.projectId,operationId:command.event.id,actorId:actor.id,
      baseRevision:base.revision,revision:next.revision,changes:command.changes,operational:base.operational!};
    const saved=applyMeasurementOperationReceipt(base,receipt);
    expect(saved.entries).toEqual(next.entries); expect(saved.services).toBe(base.services); expect(saved.audit).toEqual([]);
    expect(()=>applyMeasurementOperationReceipt(base,{...receipt,revision:receipt.revision+1})).toThrow('lacuna');
    const invalid=structuredClone(receipt); invalid.changes.entries![0].before=structuredClone(invalid.changes.entries![0].after);
    expect(()=>applyMeasurementOperationReceipt(base,invalid)).toThrow('diverge');
    const original=JSON.stringify(command);
    next.entries.find(e=>e.serviceId==='signs'&&e.measurementId==='m1')!.rows.at(-1)!.multiplier=7;
    expect(JSON.stringify(command)).toBe(original);
  });
});
