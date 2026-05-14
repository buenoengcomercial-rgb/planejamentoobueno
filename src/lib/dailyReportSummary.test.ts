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

  it('conta pendência apenas quando há produção sem diário preenchido', () => {
    const summary = summarizeDailyReportsForPeriod(baseProject, '2026-04-30', '2026-05-01');

    expect(summary.missingReports).toBe(1);
    expect(summary.entries.find(e => e.date === '2026-04-30')?.status).toBe('pending');
    expect(summary.entries.find(e => e.date === '2026-05-01')?.status).toBe('noProduction');
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