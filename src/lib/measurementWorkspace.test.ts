// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation, verifyIncorporationBackup, incorporateApprovedAdditive } from './measurementIncorporation';
import { addMeasuredPeriod, approveMeasuredPeriod, captureMeasurement, deleteMeasuredRow, editMeasuredRow, entryFor, freezeMeasuredPeriod, monthlyLines, monthlyTotal, newMeasuredRow, pasteMeasuredRow, undoMeasuredOperation, type MeasurementActor, type MeasurementClipboard } from './measurementWorkspace';
import { withDetailValue } from './productionQuantityDetails';
import { calculateMeasurementLine } from './measurementCalculations';
import type { Additive } from '@/types/project';
import { measuresForContext } from './planTakeoff';
import { monthlyExportRows } from './measurementMonthlyExport';
const actor: MeasurementActor = { id: 'tester', name: 'Teste isolado', canEdit: true, canReview: true };
const setup = async () => { const f = measurementFixture(); const backup = await createIncorporationBackup(f.project, f.plans, []); return { ...f, backup, plan: prepareIncorporation(backup) }; };
describe('Medição independente', () => {
  it('bloqueia alterações retroativas, exclusão e desfazer que afetariam acumulado fiscal posterior', async () => {
    let w = (await setup()).plan.candidate;
    const row = w.entries[0].rows[0];
    w = editMeasuredRow(w, actor, 'm1', 'detectors', { ...row, multiplier: 220 });
    const editId = w.audit.at(-1)!.id;
    w = approveMeasuredPeriod(freezeMeasuredPeriod(w, actor, 'm2'), actor, 'm2');
    const before = structuredClone(w);
    expect(() => editMeasuredRow(w, actor, 'm1', 'detectors', { ...row, multiplier: 200 })).toThrow('acumulado da 2ª medição');
    expect(() => deleteMeasuredRow(w, actor, 'm1', 'detectors', row.id)).toThrow('acumulado da 2ª medição');
    expect(() => undoMeasuredOperation(w, actor, editId)).toThrow('acumulado da 2ª medição');
    expect(w).toEqual(before);
    // Comment corrections and future quantities do not change the fiscal accumulation.
    w = editMeasuredRow(w, actor, 'm1', 'detectors', { ...entryFor(w, 'm1', 'detectors').rows[0], comment: 'Conferido' });
    w = editMeasuredRow(w, actor, 'm3', 'detectors', { ...newMeasuredRow(), multiplier: 5 });
    expect(w.periods[1]).toEqual(before.periods[1]);
    expect(monthlyLines(w, 'm3').find(l => l.service.id === 'detectors')?.accumulated).toBe(225);
  });
  it('não inclui quantidade retroativa em serviço antes zerado após aprovação posterior', async () => {
    const w = approveMeasuredPeriod(freezeMeasuredPeriod((await setup()).plan.candidate, actor, 'm3'), actor, 'm3');
    expect(() => editMeasuredRow(w, actor, 'm1', 'signs', { ...newMeasuredRow(), multiplier: 1 })).toThrow('acumulado da 3ª medição');
  });
  it('incorpora diariamente/período sem duplicar e verifica todos os arquivos do backup', async () => {
    const { backup, plan } = await setup(); await verifyIncorporationBackup(backup);
    expect(plan.issues).toEqual([]); expect(plan.reconciliation.every(r => r.difference === 0)).toBe(true);
    expect(plan.candidate.entries[0].rows[0]).toMatchObject({ multiplier: 221, comment: 'Dado preservado · 21/09/2026', origin: { date: '2026-09-21' } });
    expect(prepareIncorporation(backup).candidate).toEqual(plan.candidate);
    backup.plans[0].file = new Blob(['corrompido']); await expect(verifyIncorporationBackup(backup)).rejects.toThrow('Backup');
  });
  it('quantidade simples tem uma só memória e mantém financeiro aprovado', async () => {
    let w = (await setup()).plan.candidate;
    w = editMeasuredRow(w, actor, 'm1', 'signs', { ...newMeasuredRow('manual'), multiplier: 29 });
    w = editMeasuredRow(w, actor, 'm1', 'signs', newMeasuredRow('empty'));
    const line = monthlyLines(w, 'm1').find(l => l.service.id === 'signs')!;
    expect(line).toMatchObject({ qty: 29, accumulated: 29, balance: 371 });
    expect(line.financial.totalPeriod).toBe(362.5);
    expect(line.financial).toEqual(calculateMeasurementLine({ quantityContracted: 400, quantityPeriod: 29, quantityPriorAccum: 0, unitPriceNoBDI: 10, bdiPercent: 25 }));
  });
  it('conta três pontos na célula e grava geometria, quantidade e auditoria na mesma versão', async () => {
    let w = (await setup()).plan.candidate;
    w = editMeasuredRow(w, actor, 'm1', 'signs', newMeasuredRow('capture'));
    const mark = { id: 'mark', name: 'Placas', kind: 'count' as const, page: 1, points: [{ x: 1, y: 1 }, { x: 2, y: 3 }, { x: 4, y: 5 }], projectId: w.projectId, measurementId: 'm1', serviceId: 'signs' };
    const dest = { measurementId: 'm1', serviceId: 'signs', rowId: 'capture', field: 'measuredQuantity' as const };
    w = captureMeasurement(w, actor, dest, { ...w.plans[0], measures: [mark] }, mark);
    expect(entryFor(w, 'm1', 'signs').rows[0]).toMatchObject({ measuredQuantity: 3, source: { measureId: 'mark', points: mark.points } });
    expect(monthlyLines(w, 'm1').find(l => l.service.id === 'signs')?.financial.totalPeriod).toBe(37.5);
    expect(w.audit.at(-1)?.afterPlans?.[0].measures[0].id).toBe('mark');
    const modified = { ...mark, points: [...mark.points, { x: 5, y: 9 }] };
    w = captureMeasurement(w, actor, dest, { ...w.plans[0], measures: [modified] }, modified);
    expect(monthlyLines(w, 'm1').find(l => l.service.id === 'signs')?.qty).toBe(4);
    w = captureMeasurement(w, actor, dest, { ...w.plans[0], measures: [] }, modified, true);
    expect(entryFor(w, 'm1', 'signs').rows[0].measuredQuantity).toBe(0);
  });
  it('edita, exclui e restaura preservado com conteúdo anterior e autor', async () => {
    let w = (await setup()).plan.candidate; const row = w.entries[0].rows[0];
    w = editMeasuredRow(w, actor, 'm1', 'detectors', { ...row, multiplier: 220 });
    w = deleteMeasuredRow(w, actor, 'm1', 'detectors', row.id);
    expect(monthlyTotal(w, 'm1')).toBe(0); expect(w.audit.at(-1)?.before[0].rows[0].multiplier).toBe(220);
    w = undoMeasuredOperation(w, actor, w.audit.at(-1)!.id);
    expect(monthlyTotal(w, 'm1')).toBe(2750); expect(w.audit.at(-1)?.actor).toEqual({ id: actor.id, name: actor.name });
  });
  it('não mistura primeira, segunda e terceira medição', async () => {
    let w = (await setup()).plan.candidate;
    for (let n = 1; n <= 3; n++) w = editMeasuredRow(w, actor, `m${n}`, 'signs', { ...newMeasuredRow(`r${n}`), multiplier: n });
    expect([1, 2, 3].map(n => monthlyLines(w, `m${n}`).find(l => l.service.id === 'signs')?.qty)).toEqual([1, 2, 3]);
    expect(monthlyLines(w, 'm3').find(l => l.service.id === 'signs')?.accumulated).toBe(6);
  });
  it('Produção, cronogramas e undo externo não possuem endereço na base independente', async () => {
    const { project, plan } = await setup(); const before = JSON.stringify(plan.candidate);
    project.startDate = '2030-01-01'; project.phases[1].tasks.reverse(); project.phases[1].tasks[0].quantity = 999;
    project.phases[1].tasks[2].dailyLogs = []; project.measurements = [];
    expect(JSON.stringify(plan.candidate)).toBe(before); expect(monthlyTotal(plan.candidate, 'm1')).toBe(2762.5);
  });
  it('cópia 29 independente, referência acompanha 30 e período fechado bloqueia todo o conjunto', async () => {
    let w = (await setup()).plan.candidate; const row = { ...newMeasuredRow('original'), multiplier: 29 };
    w = editMeasuredRow(w, actor, 'm1', 'signs', row);
    const clipboard: MeasurementClipboard = { mode: 'copy', projectId: w.projectId, unit: 'UN', source: { measurementId: 'm1', serviceId: 'signs', rowId: row.id }, snapshot: row };
    w = pasteMeasuredRow(w, actor, 'm1', 'repeaters', clipboard);
    w = pasteMeasuredRow(w, actor, 'm2', 'signs', { ...clipboard, mode: 'reference' });
    w = editMeasuredRow(w, actor, 'm1', 'signs', { ...entryFor(w, 'm1', 'signs').rows[0], multiplier: 30 });
    expect(entryFor(w, 'm1', 'repeaters').rows[0].multiplier).toBe(29); expect(entryFor(w, 'm2', 'signs').rows[0].multiplier).toBe(30);
    w = approveMeasuredPeriod(freezeMeasuredPeriod(w, actor, 'm2'), actor, 'm2'); const before = JSON.stringify(w);
    expect(() => editMeasuredRow(w, actor, 'm1', 'signs', { ...entryFor(w, 'm1', 'signs').rows[0], multiplier: 31 })).toThrow('2ª medição');
    expect(JSON.stringify(w)).toBe(before);
    expect(() => deleteMeasuredRow(w, actor, 'm1', 'signs', row.id)).toThrow('acumulado da 2ª medição');
    expect(entryFor(w, 'm2', 'signs').rows[0].multiplier).toBe(30);
  });
  it('valida saldo, perfil e fator neutro', async () => {
    const w = (await setup()).plan.candidate;
    expect(() => editMeasuredRow(w, actor, 'm1', 'signs', { ...newMeasuredRow(), multiplier: 401 })).toThrow('excede');
    expect(() => editMeasuredRow(w, { ...actor, canEdit: false }, 'm1', 'signs', newMeasuredRow())).toThrow('perfil');
    expect(withDetailValue({ ...newMeasuredRow(), formula: 'A*B' }, 'measuredQuantity', 3)).toMatchObject({ multiplier: 1, measuredQuantity: 3, neutralFactor: 'multiplier' });
  });
  it('registros ambíguos e snapshot divergente bloqueiam incorporação', async () => {
    const f = measurementFixture(); f.project.measurements![1].startDate = '2026-09-01';
    const p = prepareIncorporation(await createIncorporationBackup(f.project, f.plans, []));
    expect(p.issues.map(i => i.code)).toContain('ambiguous-period');
  });
  it('nova medição é consecutiva, dura 30 dias e preserva os dados anteriores', async () => {
    const w = (await setup()).plan.candidate;
    const next = addMeasuredPeriod(w, actor);
    expect(next.periods.at(-1)).toMatchObject({ number: 4, startDate: '2026-11-23', endDate: '2026-12-22' });
    expect(next.periods.slice(0, 3)).toEqual(w.periods);
    expect(next.entries).toEqual(w.entries);
    expect(next.plans).toEqual(w.plans);
  });
  it('aditivo aprovado entra uma vez, sem substituir serviços existentes ou períodos fechados', async () => {
    let w = (await setup()).plan.candidate;
    const additive: Additive = { id: 'ad1', name: '1º Aditivo', importedAt: '', compositions: [], status: 'aprovado', version: 1, approvalSnapshots: [{ version: 1, approvedAt: '2026-10-09', bdiPercent: 25, globalDiscountPercent: 0, totals: {}, issues: [], compositions: [{ id: 'c1', item: '2.1', code: '', bank: '', description: 'Novo serviço aprovado', quantity: 20, unit: 'UN', unitPriceNoBDI: 10, unitPriceWithBDI: 12.5, total: 250, inputs: [], isNewService: true }] }] };
    w = incorporateApprovedAdditive(w, actor, additive, 2).workspace;
    const again = incorporateApprovedAdditive(w, actor, additive, 2).workspace;
    expect(again).toEqual(w); expect(monthlyLines(w, 'm1')).toHaveLength(3); expect(monthlyLines(w, 'm2')).toHaveLength(4);
    expect(() => incorporateApprovedAdditive(w, actor, { ...additive, status: 'rascunho' }, 2)).toThrow('aprovado');
  });
  it('inventário não trunca acima de mil registros', async () => {
    const f = measurementFixture(); f.project.phases[1].tasks[0].dailyLogs = Array.from({ length: 1200 }, (_, i) => ({ id: `l${i}`, date: '2026-09-21', actualQuantity: 0, plannedQuantity: 0 }));
    const p = prepareIncorporation(await createIncorporationBackup(f.project, f.plans, []));
    expect(p.inventory.dailyLogs).toBe(1200); expect(p.candidate.importedKeys).toHaveLength(1200);
  });
  it('isola marcações por obra, medição e serviço, permitindo apenas referência explícita', () => {
    const mark = { id: 'm', name: 'Placas', kind: 'count' as const, page: 1, points: [{ x: 1, y: 1 }], projectId: 'p', measurementId: 'm1', serviceId: 's' };
    expect(measuresForContext([mark], { projectId: 'p', measurementId: 'm2', serviceId: 's' })).toEqual([]);
    expect(measuresForContext([mark], { projectId: 'other', measurementId: 'm1', serviceId: 's' })).toEqual([]);
    expect(measuresForContext([mark], { projectId: 'p', measurementId: 'm1', serviceId: 'other' })).toEqual([]);
    expect(measuresForContext([mark], { taskId: 's', logId: 'm1' })).toEqual([]);
    expect(measuresForContext([mark], { projectId: 'p', measurementId: 'm2', serviceId: 's' }, ['m'])).toEqual([mark]);
  });
  it('bloqueia toda referência quando uma tarefa excede seu limite', async () => {
    let w = (await setup()).plan.candidate;
    w.services.find(s => s.id === 'repeaters')!.contracted = 29;
    const row = { ...newMeasuredRow('original'), multiplier: 29 };
    w = editMeasuredRow(w, actor, 'm1', 'signs', row);
    w = pasteMeasuredRow(w, actor, 'm1', 'repeaters', { mode: 'reference', projectId: w.projectId, unit: 'UN', source: { measurementId: 'm1', serviceId: 'signs', rowId: row.id }, snapshot: row });
    expect(() => editMeasuredRow(w, actor, 'm1', 'signs', { ...entryFor(w, 'm1', 'signs').rows[0], multiplier: 30 })).toThrow('Repetidores');
    expect(entryFor(w, 'm1', 'signs').rows[0].multiplier).toBe(29);
  });
  it('recorta sem duplicar e impede restauração sobre edição posterior', async () => {
    let w = (await setup()).plan.candidate;
    const row = { ...newMeasuredRow('move'), multiplier: 29 };
    w = editMeasuredRow(w, actor, 'm1', 'signs', row); const id = w.audit.at(-1)!.id;
    w = pasteMeasuredRow(w, actor, 'm2', 'signs', { mode: 'cut', projectId: w.projectId, unit: 'UN', source: { measurementId: 'm1', serviceId: 'signs', rowId: row.id }, snapshot: row });
    expect(entryFor(w, 'm1', 'signs').rows).toEqual([]); expect(entryFor(w, 'm2', 'signs').rows[0].multiplier).toBe(29);
    expect(() => undoMeasuredOperation(w, actor, id)).toThrow('edição posterior');
  });
  it('exporta os mesmos números monetários e acumulados da tela', async () => {
    let w = (await setup()).plan.candidate;
    w = editMeasuredRow(w, actor, 'm1', 'signs', { ...newMeasuredRow(), multiplier: 3 });
    const exported = monthlyExportRows(w, 'm1'); const line = exported.find(row => row[0] === '1.1.2')!;
    expect(line[4]).toBe(3); expect(line[7]).toBe(37.5); expect(exported.at(-1)?.[7]).toBe(monthlyTotal(w, 'm1'));
  });
  it('não omite silenciosamente serviço fiscal ausente da Produção atual', async () => {
    const f = measurementFixture();
    f.project.measurements![0].status = 'approved';
    f.project.measurements![0].items.push({ taskId: 'removed-task', item: '1.9', phaseId: 'old', phaseChain: 'Prédio antigo', description: 'Serviço antigo', unit: 'UN', itemCode: '', priceBank: '', qtyContracted: 30, qtyPriorAccum: 0, qtyProposed: 29, unitPriceNoBDI: 10, unitPriceWithBDI: 12.5 });
    const backup = await createIncorporationBackup(f.project, f.plans, []);
    expect(prepareIncorporation(backup).issues.map(i => i.code)).toContain('unmapped-snapshot');
    expect(backup.project.measurements![0].items[0].qtyProposed).toBe(29);
  });
});
