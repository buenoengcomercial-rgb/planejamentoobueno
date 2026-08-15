import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { isDailyReportEmpty, summarizeDailyReportsForPeriod } from './dailyReportSummary';

const baseProject = {
  phases: [
    {
      tasks: [
        {
          dailyLogs: [{ date: '2026-04-30', actualQuantity: 1 }],
        },
      ],
    },
  ],
} as unknown as Project;

describe('dailyReportSummary', () => {
  it('só marca impedimento quando há texto real em impediments', () => {
    const summary = summarizeDailyReportsForPeriod({
      ...baseProject,
      dailyReports: [{
        id: 'dr-1',
        date: '2026-04-30',
        workCondition: 'normal',
        impediments: '   ',
        teamsPresent: [],
        equipment: [],
        attachments: [],
        createdAt: '2026-04-30T00:00:00.000Z',
        updatedAt: '2026-04-30T00:00:00.000Z',
      }],
    }, '2026-04-30', '2026-04-30');

    expect(summary.impedimentDays).toBe(0);
    expect(summary.entries[0].hasImpediment).toBe(false);
    expect(summary.entries[0].status).not.toBe('impediment');
  });

  it('diferencia pendência vencida de ausência futura e de sem produção declarado', () => {
    const summary = summarizeDailyReportsForPeriod(baseProject, '2026-04-30', '2026-05-01');

    expect(summary.missingReports).toBe(2);
    expect(summary.entries.find(e => e.date === '2026-04-30')?.status).toBe('pending');
    expect(summary.entries.find(e => e.date === '2026-05-01')?.status).toBe('pending');
    expect(summary.noProductionDays).toBe(0);
  });

  it('usa sem produção somente quando o diário registra a declaração', () => {
    const summary = summarizeDailyReportsForPeriod({
      ...baseProject,
      phases: [],
      dailyReports: [{
        id: 'dr-no-production',
        date: '2026-04-30',
        noProductionDeclared: true,
        createdAt: '2026-04-30T00:00:00.000Z',
        updatedAt: '2026-04-30T00:00:00.000Z',
      }],
    }, '2026-04-30', '2026-04-30');

    expect(summary.entries[0].status).toBe('noProduction');
    expect(summary.noProductionDays).toBe(1);
    expect(summary.filledReports).toBe(1);
  });

  it('identifica diário completamente vazio', () => {
    expect(isDailyReportEmpty({
      date: '2026-04-30',
      responsible: '',
      impediments: '   ',
      teamsPresent: [],
      equipment: [],
      attachments: [],
    })).toBe(true);
  });
});
