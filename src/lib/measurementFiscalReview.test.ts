// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { fiscalReviewIssuesForWorkspace } from './measurementFiscalReview';
import { editMeasuredRow, entryFor, newMeasuredRow } from './measurementWorkspace';

const actor = { id: 'fiscal-review-test', name: 'Teste isolado', canEdit: true };
async function workspace() {
  const { project, plans } = measurementFixture();
  return prepareIncorporation(await createIncorporationBackup(project, plans, [])).candidate;
}

describe('validação fiscal da Medição independente', () => {
  it('usa apenas a medição selecionada: primeira com quantidade e segunda vazia', async () => {
    const current = await workspace();
    const first = fiscalReviewIssuesForWorkspace(current, 'm1');
    const second = fiscalReviewIssuesForWorkspace(current, 'm2');
    expect(first.some(issue => issue.code === 'no-items')).toBe(false);
    expect(second.some(issue => issue.code === 'no-items' && issue.level === 'error')).toBe(true);
    expect(first.some(issue => issue.code === 'period-overlap')).toBe(false);
    expect(second.some(issue => issue.code === 'number-duplicated')).toBe(false);
  });

  it('preserva avisos contratuais e identifica desequilíbrio sem tocar nos registros', async () => {
    const original = await workspace();
    const current = structuredClone(original);
    const existing = entryFor(current, 'm1', 'detectors').rows[0];
    current.entries.find(entry => entry.measurementId === 'm1' && entry.serviceId === 'detectors')!.rows[0] = { ...existing, multiplier: 401 };
    const before = structuredClone(current);
    const issues = fiscalReviewIssuesForWorkspace(current, 'm1');
    expect(issues.map(issue => issue.code)).toContain('qty-over-balance');
    expect(issues.map(issue => issue.code)).toContain('accum-over-contracted');
    expect(issues.map(issue => issue.code)).toContain('contract-incomplete');
    expect(current).toEqual(before);
    expect(original.entries).not.toEqual(current.entries);
  });

  it('reconhece lançamento da terceira medição sem somá-lo à segunda', async () => {
    const base = await workspace();
    const current = editMeasuredRow(base, actor, 'm3', 'signs', { ...newMeasuredRow('third-row'), multiplier: 3 });
    expect(fiscalReviewIssuesForWorkspace(current, 'm2').some(issue => issue.code === 'no-items')).toBe(true);
    expect(fiscalReviewIssuesForWorkspace(current, 'm3').some(issue => issue.code === 'no-items')).toBe(false);
  });
});
