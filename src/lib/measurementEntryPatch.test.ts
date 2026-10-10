// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { addMeasuredPeriod, editMeasuredRow, newMeasuredRow } from './measurementWorkspace';
import { measurementEntryPatch } from './measurementEntryPatch';

async function fixture() {
  const f = measurementFixture();
  return prepareIncorporation(await createIncorporationBackup(f.project, [], [])).candidate;
}
const actor = { id: 'test', name: 'Teste', canEdit: true };
describe('payload restrito aos quantitativos', () => {
  it('recarregar JSONB com chaves reordenadas mantém o envio restrito e protege o histórico', async () => {
    const base = await fixture();
    const confirmed = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 3 });
    const pending = editMeasuredRow(confirmed, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 4 });
    const reloaded = JSON.parse(JSON.stringify(confirmed, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value));
    expect(measurementEntryPatch(reloaded, pending)?.entries).toEqual(pending.audit.at(-1)!.after);
    const tampered = structuredClone(pending); tampered.audit[0].action += ' adulterada';
    expect(measurementEntryPatch(reloaded, tampered)).toBeNull();
    const reordered = structuredClone(pending); reordered.entries.reverse();
    expect(measurementEntryPatch(reloaded, reordered)).toBeNull();
  });
  it('uma edição transmite somente a ocorrência, sem os 1.200 serviços ou o histórico anterior', async () => {
    const base = await fixture();
    base.services.push(...Array.from({ length: 1200 - base.services.length }, (_, i) => ({ ...base.services[0], id: `extra-${i}`, item: `9.${i}` })));
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 3 });
    const patch = measurementEntryPatch(base, next)!;
    expect(patch.entries).toEqual(next.audit.at(-1)!.after);
    expect(patch.entries).toHaveLength(1);
    expect(Object.keys(patch)).toEqual(['entries', 'event']);
    expect(Buffer.byteLength(JSON.stringify(patch))).toBeLessThan(Buffer.byteLength(JSON.stringify(next)) / 100);
    expect(next.periods).toEqual(base.periods);
    expect(next.services).toEqual(base.services);
  });
  it('mudança de contrato, período, histórico antigo ou remoção de entrada exige transação completa', async () => {
    const base = await fixture();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 3 });
    expect(measurementEntryPatch(null, next)).toBeNull();
    expect(measurementEntryPatch(base, addMeasuredPeriod(base, actor))).toBeNull();
    const contract = structuredClone(next); contract.services[0].contracted++;
    expect(measurementEntryPatch(base, contract)).toBeNull();
    const removal = structuredClone(next); removal.entries = removal.entries.filter(e => e.serviceId === 'signs');
    expect(measurementEntryPatch(base, removal)).toBeNull();
    const history = editMeasuredRow(next, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 4 });
    history.audit[0] = { ...history.audit[0], action: 'Histórico alterado' };
    expect(measurementEntryPatch(next, history)).toBeNull();
  });
});
