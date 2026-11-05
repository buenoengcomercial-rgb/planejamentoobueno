import { describe, expect, it } from 'vitest';
import { additivePlanningPatch } from './additivePlanningPatch';

describe('envio parcial do Cronograma do Aditivo', () => {
  const budget = { compositions: [{ id: 'item-1', total: 100 }], name: 'Aditivo 1' };

  it('inclui somente o rascunho alterado e sua base de comparação', () => {
    const before = { ...budget, scheduleDraft: { plannedTasks: [{ id: 'task-1', startDate: '2026-10-01' }] } };
    const after = { ...before, scheduleDraft: { plannedTasks: [{ id: 'task-1', startDate: '2026-10-02' }] } };
    expect(additivePlanningPatch(before, after)).toEqual({
      expected: { scheduleDraft: before.scheduleDraft }, row: { scheduleDraft: after.scheduleDraft },
    });
    expect(JSON.stringify(additivePlanningPatch(before, after))).not.toContain('compositions');
  });

  it('retém o envio integral quando orçamento ou identidade também mudam', () => {
    expect(additivePlanningPatch(budget, { ...budget, name: 'Outro' })).toBeNull();
    expect(additivePlanningPatch(budget, { ...budget, compositions: [] })).toBeNull();
  });

  it('não cria gravação se o planejamento não mudou', () => {
    expect(additivePlanningPatch(budget, { ...budget })).toBeNull();
  });
});
