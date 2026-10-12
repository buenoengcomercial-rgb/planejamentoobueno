// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { transactMeasurement } from './measurementWorkspace';
import { measurementPlanCatalogPatch, applyMeasurementPlanCatalogReceipt } from './measurementPlanCatalogPatch';
import { encodeMeasurementWorkspace } from './measurementCloudCodec';
const actor = { id: 'user', name: 'Teste', canEdit: true };
async function fixture() {
  const f = measurementFixture();
  f.plans = [];
  return prepareIncorporation(await createIncorporationBackup(f.project, f.plans, [])).candidate;
}
describe('Catálogo pontual de plantas', () => {
  it('envia somente a nova planta, aceita recibo compacto e preserva lançamentos', async () => {
    const base = await fixture();
    const plan = { id: 'dwf-plan', name: 'Model.dwf', floor: '1º andar', kind: 'dwf' as const,
      file: new Blob(['dwf']), scales: {}, measures: [], storagePath: `${base.projectId}/dwf-plan/op.dwf` };
    const next = transactMeasurement(base, actor, 'Gerir desenhos', draft => { draft.plans.push(plan); });
    const patch = measurementPlanCatalogPatch(base, next)!;
    expect(patch.kind).toBe('add');
    expect(patch.event.beforePlans).toBeUndefined();
    expect(patch.event.afterPlans).toBeUndefined();
    expect('entries' in patch).toBe(false);
    const event = { ...patch.event, planDelta: { kind: patch.kind, planId: plan.id, afterPlan: plan } };
    const receipt = encodeMeasurementWorkspace({ projectId: base.projectId, revision: next.revision, patch, event });
    const saved = applyMeasurementPlanCatalogReceipt(base, next, patch, receipt)!;
    expect(saved.entries).toEqual(base.entries);
    expect(saved.audit.at(-1)?.planDelta?.afterPlan?.file).toBe(plan.file);
    expect(applyMeasurementPlanCatalogReceipt(base, next, patch, { ...receipt as object, revision: 900 })).toBeNull();
    const mixed = structuredClone(next); mixed.entries[0].rows[0].comment = 'alteração não relacionada';
    expect(measurementPlanCatalogPatch(base, mixed)).toBeNull();
  });
  it('metadados e arquivamento usam delta, calibração não entra no cadastro', async () => {
    const base = await fixture();
    base.plans = [{ id: 'p', name: 'Model.dwf', floor: '1º', kind: 'dwf', file: new Blob(['dwf']),
      scales: {}, measures: [], storagePath: `${base.projectId}/p/op.dwf` }];
    const rename = transactMeasurement(base, actor, 'Gerir desenhos', draft => { draft.plans[0].floor = 'Térreo'; });
    expect(measurementPlanCatalogPatch(base, rename)?.kind).toBe('update');
    const archive = transactMeasurement(base, actor, 'Gerir desenhos', draft => { draft.plans = []; });
    expect(measurementPlanCatalogPatch(base, archive)?.kind).toBe('archive');
    const scale = transactMeasurement(base, actor, 'Gerir desenhos', draft => { draft.plans[0].scales = {1: 0.01}; });
    expect(measurementPlanCatalogPatch(base, scale)).toBeNull();
  });
});
