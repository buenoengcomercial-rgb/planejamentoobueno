import { describe, expect, it } from 'vitest';
import { buildMonthlyExecution } from '@/lib/monthlyExecution';
import { monthlyLines, newMeasuredRow } from '@/lib/measurementWorkspace';
import { prepareIncorporation } from '@/lib/measurementIncorporation';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';

function fixture() {
  const { project, plans } = measurementFixture();
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'backup', createdAt: '', manifest: { dataHash: '', files: [] } });
  candidate.entries = [
    { projectId: project.id, serviceId: 'detectors', measurementId: 'm1', rows: [
      { ...newMeasuredRow('dated'), multiplier: 30, origin: { kind: 'daily', date: '2026-08-26' } },
      { ...newMeasuredRow('undated'), multiplier: 40, origin: { kind: 'period' } },
    ] },
    { projectId: project.id, serviceId: 'detectors', measurementId: 'm2', rows: [
      { ...newMeasuredRow('out-of-range'), multiplier: 15, origin: { kind: 'daily', date: '2026-08-26' } },
    ] },
  ];
  return { project, candidate };
}

describe('quadro mensal de execução', () => {
  it('mantém uma linha, concilia os meses e usa o contratado vigente na segunda medição', () => {
    const { project, candidate } = fixture();
    candidate.services[0].contracted = 300;
    candidate.services[0].additiveAdjustments = [{ additiveId: 'a', additiveVersion: 1, compositionId: 'c', firstNumber: 3, net: -100, valueDeltaWithBDI: 0, valueDeltaNoBDI: 0 }];
    const result = buildMonthlyExecution(candidate, project);
    expect(result.months).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ contracted: 400, accumulated: 85, balance: 315, months: {
      '2026-08': { quantity: 30, competence: 0 }, '2026-09': { quantity: 40, competence: 40 },
      '2026-10': { quantity: 15, competence: 15 },
    } });
    expect(Object.values(result.rows[0].months).reduce((sum, cell) => sum + cell.quantity, 0)).toBe(85);
  });

  it('mantém o total fiscal quando o detalhe datado diverge do aprovado', () => {
    const { project, candidate } = fixture();
    candidate.periods[0].frozen = monthlyLines(candidate, 'm1').map(line => line.service.id === 'detectors' ? { ...line, qty: 65 } : line);
    candidate.periods[0].status = 'approved';
    const row = buildMonthlyExecution(candidate, project).rows[0];
    expect(row.months['2026-08']).toBeUndefined();
    expect(row.months['2026-09']).toEqual({ quantity: 65, competence: 65, discrepancy: true });
    expect(row.accumulated).toBe(80);
  });
});
