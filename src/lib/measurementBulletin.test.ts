// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { addMeasuredPeriod, editMeasuredBulletin, editMeasuredRow, freezeMeasuredPeriod, measurementBulletin, monthlyLines, newMeasuredRow, undoMeasuredOperation } from './measurementWorkspace';
import { monthlyExportRows } from './measurementMonthlyExport';
const actor = { id: 'test', name: 'Teste', canEdit: true, canReview: true };
async function fixture() {
  const f = measurementFixture();
  return prepareIncorporation(await createIncorporationBackup(f.project, f.plans, [])).candidate;
}
describe('Boletim por medição', () => {
  it('não renumera um período existente nem permite saltar para a quinta medição', async () => {
    const w = await fixture();
    expect(() => editMeasuredBulletin(w, actor, 'm3', { number: 5 })).toThrow('Número');
    w.periods = w.periods.slice(0, 1);
    expect(() => editMeasuredBulletin(w, actor, 'm1', { number: 5 })).toThrow('Número');
    expect(editMeasuredBulletin(w, actor, 'm1', { number: 1 })).toBe(w);
  });
  it('edita todos os campos somente no período selecionado, preservando contrato, quantitativos e preços', async () => {
    const w = await fixture(), before = structuredClone(w);
    const patch = { projectName: 'Obra revisada', contract: { contractor: 'Contratante', contracted: 'Empresa', contractNumber: '123', contractObject: 'Objeto', location: 'Município', budgetSource: 'SINAPI', artNumber: '456', bdiPercent: 30 } };
    const next = editMeasuredBulletin(w, actor, 'm2', patch);
    expect(measurementBulletin(next, 'm2')).toMatchObject(patch);
    expect(next.periods.filter(p => p.id !== 'm2')).toEqual(w.periods.filter(p => p.id !== 'm2'));
    for (const id of ['m1', 'm2', 'm3']) expect(monthlyLines(next, id)).toEqual(monthlyLines(w, id));
    expect([next.services, next.entries, next.plans, next.contract]).toEqual([w.services, w.entries, w.plans, w.contract]);
    expect(next.audit.at(-1)?.bulletinChange?.before.bulletin).toEqual(measurementBulletin(w, 'm2'));
    expect(next.audit.at(-1)?.actor).toEqual({ id: actor.id, name: actor.name });
    expect(w).toEqual(before);
    expect(editMeasuredBulletin(next, actor, 'm2', patch)).toBe(next);
  });
  it('bloqueia perfil de consulta, período fiscal, números repetidos, reordenação e BDI inválido', async () => {
    const w = await fixture();
    expect(() => editMeasuredBulletin(w, { ...actor, canEdit: false }, 'm1', { projectName: 'Teste' })).toThrow('perfil');
    for (const number of [0, 1.5, 2, 4]) expect(() => editMeasuredBulletin(w, actor, 'm1', { number })).toThrow('Número');
    expect(() => editMeasuredBulletin(w, actor, 'm1', { contract: { bdiPercent: NaN } })).toThrow('BDI');
    expect(() => editMeasuredBulletin(w, actor, 'm1', { projectName: '' })).toThrow('nome');
    const closed = freezeMeasuredPeriod(w, actor, 'm1');
    expect(closed.periods[0].bulletin).toEqual(measurementBulletin(w, 'm1'));
    expect(() => editMeasuredBulletin(closed, actor, 'm1', { projectName: 'Teste' })).toThrow('bloqueado');
    w.services.push({ ...w.services[0], id: 'aditivo', availableFromNumber: 4 });
    expect(() => editMeasuredBulletin(w, actor, 'm3', { number: 4 })).toThrow('Número');
  });
  it('herda o cabeçalho na próxima medição sem compartilhar a edição ou substituir snapshots', async () => {
    let w = await fixture();
    w = editMeasuredBulletin(w, actor, 'm3', { contract: { artNumber: 'ART-3' } });
    w = freezeMeasuredPeriod(w, actor, 'm3');
    const closed = structuredClone(w.periods[2]);
    w = addMeasuredPeriod(w, actor);
    const id = w.periods.at(-1)!.id;
    expect(measurementBulletin(w, id).contract.artNumber).toBe('ART-3');
    w = editMeasuredBulletin(w, actor, id, { contract: { artNumber: 'ART-4' } });
    expect(w.periods[2]).toEqual(closed);
  });
  it('restaura somente o boletim, preserva quantitativo posterior e bloqueia conflito de cabeçalho', async () => {
    const original = await fixture();
    let w = editMeasuredBulletin(original, actor, 'm1', { contract: { artNumber: 'ART' } });
    const id = w.audit.at(-1)!.id;
    w = editMeasuredRow(w, actor, 'm1', 'signs', { ...newMeasuredRow('nova'), multiplier: 3 });
    const restored = undoMeasuredOperation(w, actor, id);
    expect(measurementBulletin(restored, 'm1')).toEqual(measurementBulletin(original, 'm1'));
    expect(restored.entries).toEqual(w.entries);
    w = editMeasuredBulletin(w, actor, 'm1', { contract: { artNumber: 'Posterior' } });
    expect(() => undoMeasuredOperation(w, actor, id)).toThrow('edição posterior');
  });
  it('exporta todos os campos confirmados do boletim da medição selecionada', async () => {
    let w = await fixture();
    w = editMeasuredBulletin(w, actor, 'm2', { projectName: 'Obra exportada', contract: { contractor: 'Cliente', contracted: 'Empresa', contractObject: 'Escopo', contractNumber: 'CTR', artNumber: 'ART', location: 'Cidade', budgetSource: 'Fonte' } });
    const cells = monthlyExportRows(w, 'm2').flat();
    for (const value of ['Obra exportada', 'Cliente', 'Empresa', 'Escopo', 'CTR', 'ART', 'Cidade', 'Fonte']) expect(cells).toContain(value);
    expect(monthlyExportRows(w, 'm1').flat()).not.toContain('Obra exportada');
  });
});
