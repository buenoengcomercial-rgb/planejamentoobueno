// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { addMeasuredPeriod, approveMeasuredPeriod, editMeasuredBulletin, editMeasuredRow, entryFor, fiscalSubmissionCurrent, freezeMeasuredPeriod, monthlyLines, newMeasuredRow } from './measurementWorkspace';
import { deleteMeasuredPeriod, restoreMeasuredPeriod } from './measurementLifecycle';
const actor = { id: 'tester', name: 'Teste', canEdit: true, canReview: true };
async function setup() { const f = measurementFixture(); return prepareIncorporation(await createIncorporationBackup(f.project, f.plans, [])).candidate; }
describe('Revisão e exclusão recuperável de medições', () => {
  it('reconhece um envio legado incorporado sem evento novo e libera reenvio após alteração', async () => {
    const sent = freezeMeasuredPeriod(await setup(), actor, 'm1');
    const imported = structuredClone(sent);
    imported.revision = 0;
    imported.audit = [];
    imported.periods[0].originalSnapshot = {
      ...imported.periods[0].originalSnapshot!, status: 'in_review',
      startDate: imported.periods[0].startDate, endDate: imported.periods[0].endDate,
    };
    // O preço congelado pelo fiscal pode ser diferente do contrato atual.
    imported.periods[0].frozen![0].service.priceWithBDI += 123;
    imported.periods[0].frozen![0].financial.totalPeriod += 123;
    expect(fiscalSubmissionCurrent(imported, 'm1')).toBe(true);
    expect(freezeMeasuredPeriod(imported, actor, 'm1')).toBe(imported);
    const corrected = editMeasuredRow(imported, actor, 'm1', 'detectors', { ...entryFor(imported, 'm1', 'detectors').rows[0], multiplier: 220 });
    expect(fiscalSubmissionCurrent(corrected, 'm1')).toBe(false);
    const oldDate = structuredClone(imported);
    oldDate.periods[0].endDate = '2026-09-29';
    expect(fiscalSubmissionCurrent(oldDate, 'm1')).toBe(false);
  });
  it('não reenvia proposta idêntica e permite novo envio após corrigir a quantidade', async () => {
    const sent = freezeMeasuredPeriod(await setup(), actor, 'm1');
    expect(fiscalSubmissionCurrent(sent, 'm1')).toBe(true);
    expect(freezeMeasuredPeriod(sent, actor, 'm1')).toBe(sent);
    expect(fiscalSubmissionCurrent(editMeasuredBulletin(sent, actor, 'm1', { contract: { artNumber: 'ART corrigida' } }), 'm1')).toBe(false);
    const corrected = editMeasuredRow(sent, actor, 'm1', 'detectors', { ...entryFor(sent, 'm1', 'detectors').rows[0], multiplier: 220 });
    expect(fiscalSubmissionCurrent(corrected, 'm1')).toBe(false);
    const resent = freezeMeasuredPeriod(corrected, actor, 'm1');
    expect(resent.revision).toBe(corrected.revision + 1);
    expect(resent.periods[0].frozen![0].qty).toBe(220);
    expect(sent.periods[0].frozen![0].qty).toBe(221);
  });
  it('permite corrigir durante a análise, preserva envio e congela somente ao aprovar', async () => {
    const original = await setup(), sent = freezeMeasuredPeriod(original, actor, 'm1');
    const sentEvent = structuredClone(sent.audit.at(-1));
    let w = editMeasuredRow(sent, actor, 'm1', 'detectors', { ...entryFor(sent, 'm1', 'detectors').rows[0], multiplier: 220 });
    expect(monthlyLines(w, 'm1')[0].qty).toBe(220);
    expect(monthlyLines(w, 'm2')[0].prior).toBe(220);
    expect(w.periods[0].frozen![0].qty).toBe(221);
    w = approveMeasuredPeriod(w, actor, 'm1');
    expect(w.periods[0].status).toBe('approved'); expect(w.periods[0].frozen![0].qty).toBe(220);
    expect(w.audit.find(a => a.id === sentEvent!.id)).toEqual(sentEvent);
    expect(() => editMeasuredRow(w, actor, 'm1', 'detectors', { ...entryFor(w, 'm1', 'detectors').rows[0], multiplier: 219 })).toThrow('bloqueado');
    expect(() => freezeMeasuredPeriod(w, actor, 'm1')).toThrow('indisponível');
  });
  it('criar ou enviar períodos posteriores não bloqueia o primeiro; aprovação exige permissão', async () => {
    const w = addMeasuredPeriod(freezeMeasuredPeriod(freezeMeasuredPeriod(await setup(), actor, 'm1'), actor, 'm2'), actor);
    expect(() => editMeasuredRow(w, actor, 'm1', 'detectors', { ...entryFor(w, 'm1', 'detectors').rows[0], multiplier: 220 })).not.toThrow();
    expect(() => approveMeasuredPeriod(w, { ...actor, canReview: false }, 'm1')).toThrow('permissão');
    expect(() => approveMeasuredPeriod(w, actor, 'm3')).toThrow('Envie');
  });
  it('exclui a última de teste, guarda conteúdo recuperável e restaura os mesmos IDs e quantidades', async () => {
    let w = addMeasuredPeriod(await setup(), actor); const id = w.periods.at(-1)!.id;
    w = editMeasuredRow(w, actor, id, 'signs', { ...newMeasuredRow('teste'), multiplier: 3 });
    const original = structuredClone(w); w = deleteMeasuredPeriod(w, actor, id, 'Medição de teste');
    expect(w.periods).toEqual(original.periods.slice(0, -1)); expect(w.entries.every(e => e.measurementId !== id)).toBe(true);
    expect(w.audit.at(-1)!.before).toEqual(original.entries.filter(e => e.measurementId === id));
    expect(w.plans).toEqual(original.plans); expect(w.services).toEqual(original.services);
    const restored = restoreMeasuredPeriod(w, actor, w.audit.at(-1)!.id, 'Recuperar teste');
    expect(restored.periods).toEqual(original.periods); expect(restored.entries).toEqual(original.entries);
    expect(() => restoreMeasuredPeriod(restored, actor, w.audit.at(-1)!.id, 'Repetir')).toThrow();
    const recreated = addMeasuredPeriod(w, actor);
    expect(recreated.periods.at(-1)!.number).toBe(4);
    expect(() => restoreMeasuredPeriod(recreated, actor, w.audit.at(-1)!.id, 'Recuperar')).toThrow('sequência');
  });
  it('protege a primeira, períodos aprovados e períodos com sucessores', async () => {
    const w = addMeasuredPeriod(await setup(), actor), id = w.periods.at(-1)!.id;
    expect(() => deleteMeasuredPeriod(w, actor, 'm1', 'Teste')).toThrow('primeira');
    expect(() => deleteMeasuredPeriod(w, actor, 'm2', 'Teste')).toThrow('última');
    expect(() => deleteMeasuredPeriod(approveMeasuredPeriod(freezeMeasuredPeriod(w, actor, id), actor, id), actor, id, 'Teste')).toThrow('aprovada');
    expect(() => deleteMeasuredPeriod(w, { ...actor, canEdit: false }, id, 'Teste')).toThrow('perfil');
  });
});
