import { describe, expect, it } from 'vitest';
import { buildMonthlyExecution } from '@/lib/monthlyExecution';
import { monthlyLines, newMeasuredRow } from '@/lib/measurementWorkspace';
import { prepareIncorporation } from '@/lib/measurementIncorporation';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';

function fixture() {
  const { project, plans } = measurementFixture();
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'backup', createdAt: '', manifest: { dataHash: '', files: [] } });
  candidate.periods.push({
    id: 'm5', number: 5, startDate: '2026-12-23', endDate: '2027-01-21', status: 'draft',
  });
  candidate.entries = [
    { projectId: project.id, serviceId: 'detectors', measurementId: 'm1', rows: [
      { ...newMeasuredRow('dated'), multiplier: 30, origin: { kind: 'daily', date: '2026-08-26' } },
      { ...newMeasuredRow('undated'), multiplier: 40, origin: { kind: 'period' } },
    ] },
    { projectId: project.id, serviceId: 'detectors', measurementId: 'm5', rows: [
      { ...newMeasuredRow('resumed'), multiplier: 15 },
    ] },
  ];
  return { project, candidate };
}

describe('grade mensal de execução', () => {
  it('usa a competência, preserva as lacunas e soma a primeira e quinta medição na mesma atividade', () => {
    const { project, candidate } = fixture();
    const result = buildMonthlyExecution(candidate, project);
    expect(result.months).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
    const detectors = result.rows.filter(row => row.id === 'detectors');
    expect(detectors).toHaveLength(1);
    expect(detectors[0]).toMatchObject({ contracted: 400, accumulated: 85, balance: 315, months: {
      '2026-09': [{ number: 1, quantity: 70, value: 875 }],
      '2027-01': [{ number: 5, quantity: 15, value: 187.5 }],
    } });
    expect(Object.keys(detectors[0].months)).toEqual(['2026-09', '2027-01']);
    expect(result.rows.find(row => row.id === 'signs')?.months).toEqual({});
    expect(result.totals.get('2026-09')).toBe(875);
  });

  it('mantém o total fiscal quando o detalhe diverge do aprovado', () => {
    const { project, candidate } = fixture();
    candidate.periods[0].frozen = monthlyLines(candidate, 'm1').map(line => line.service.id === 'detectors'
      ? { ...line, qty: 65, financial: { ...line.financial, totalPeriod: 812.5 } } : line);
    candidate.periods[0].status = 'approved';
    const row = buildMonthlyExecution(candidate, project).rows.find(item => item.id === 'detectors')!;
    expect(row.months['2026-09']).toEqual([{ number: 1, quantity: 65, value: 812.5, status: 'Aprovada' }]);
    expect(row.accumulated).toBe(80);
  });

  it('agrupa duas medições com a mesma competência e preserva as quantidades de cada uma', () => {
    const { project, candidate } = fixture();
    candidate.periods.at(-1)!.endDate = '2026-09-30';
    const result = buildMonthlyExecution(candidate, project);
    expect(result.periods.get('2026-09')).toEqual([1, 5]);
    expect(result.totals.get('2026-09')).toBe(1062.5);
  });
});
