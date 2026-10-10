import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMeasurementActions, type UseMeasurementActionsParams } from './useMeasurementActions';
import type { Project } from '@/types/project';

function harness() {
  const project = { id:'p',phases:[],measurements:[{id:'m',number:1,status:'generated',items:[{taskId:'t',qtyProposed:29}],history:[]}],auditLogs:[] } as unknown as Project;
  const projectRef = { current:project };
  const onProjectChange = vi.fn();
  const params = {project,projectRef,onProjectChange,auditUser:{userId:'engineer',userName:'Engenheira'},activeMeasurement:project.measurements![0],rows:[{taskId:'t',qtyPeriod:30}],dailyReportsSummary:{startDate:'2026-10-01',endDate:'2026-10-31',totalDays:31,filledReports:1,reportDates:['2026-10-01']},setConfirmEdit:vi.fn(),setEditReason:vi.fn(),setActiveId:vi.fn(),setConfirmDelete:vi.fn()} as unknown as UseMeasurementActionsParams;
  return { ...renderHook(() => useMeasurementActions(params)), projectRef,onProjectChange };
}
describe('envio fiscal único', () => {
  it('congela 30, resumo, status e auditoria em um único update; a aprovação preserva 30', () => {
    const hook = harness();
    act(() => hook.result.current.setStatus('in_review'));
    expect(hook.onProjectChange).toHaveBeenCalledTimes(1);
    expect(hook.projectRef.current.measurements![0]).toMatchObject({status:'in_review',items:[{qtyProposed:30}],dailyReportSnapshot:{filledReports:1}});
    expect(hook.projectRef.current.auditLogs).toHaveLength(1);
    act(() => hook.result.current.setStatus('approved'));
    expect(hook.projectRef.current.measurements![0]).toMatchObject({status:'approved',items:[{qtyProposed:30}]});
    expect(hook.projectRef.current.auditLogs).toHaveLength(2);
  });
  it('exclusão é explícita e mantém o snapshot completo anterior na auditoria', () => {
    const hook = harness(); act(() => hook.result.current.deleteMeasurement());
    expect(hook.projectRef.current.measurements).toEqual([]);
    expect(hook.projectRef.current.auditLogs![0]).toMatchObject({ action:'deleted',before:{id:'m',items:[{qtyProposed:29}]} });
  });
  it('a Medição não cria registros de produção, nem IDs manuais compartilhados entre tarefas', () => {
    const hook = harness(); act(() => hook.result.current.setManualPeriodQuantity('t',3));
    expect(hook.onProjectChange).not.toHaveBeenCalled();
    act(() => hook.result.current.patchSnapshotItem('t',{qtyProposed:99},'Quantidade'));
    expect(hook.onProjectChange).not.toHaveBeenCalled();
  });
});
