import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installIndexedDbMock } from '@/test/indexedDbMock';
import type { DailyReport } from '@/types/project';
import { protectDailyReportDraft, readDailyReportDrafts, clearDailyReportDraft } from './dailyReportDrafts';
beforeEach(installIndexedDbMock);
afterEach(() => vi.unstubAllGlobals());
const report: DailyReport = { id: 'r', date: '2026-10-09', observations: 'Texto fictício', createdAt: 'now', updatedAt: 'now' };
describe('daily report durable drafts', () => {
  it('recovers the in-memory copy when durable storage is unavailable and clears only its revision', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(protectDailyReportDraft('no-storage', 'u', { revision: 'one', base: report, local: report })).rejects.toThrow('armazenamento');
    expect((await readDailyReportDrafts('no-storage', 'u'))[report.date].revision).toBe('one');
    await expect(protectDailyReportDraft('no-storage', 'u', { revision: 'two', base: report, local: { ...report, observations: 'Mais recente' } })).rejects.toThrow();
    expect(await clearDailyReportDraft('no-storage', 'u', report.date, 'one')).toBe(false);
    expect(await clearDailyReportDraft('no-storage', 'u', report.date, 'two')).toBe(true);
    expect(await readDailyReportDrafts('no-storage', 'u')).toEqual({});
  });
  it('recovers exactly the attempted fields and attachment references', async () => {
    const local = { ...report, attachments: [{ id: 'file', storagePath: 'fake/path.jpg' }] } as DailyReport;
    await protectDailyReportDraft('p', 'u', { revision: 'one', base: report, local });
    expect((await readDailyReportDrafts('p', 'u'))[report.date].local).toEqual(local);
    expect(await readDailyReportDrafts('p', 'other-user')).toEqual({});
    expect(await readDailyReportDrafts('other-project', 'u')).toEqual({});
  });
  it('does not clear a newer queued draft when an old save confirms', async () => {
    await protectDailyReportDraft('p2', 'u', { revision: 'one', base: report, local: report });
    await protectDailyReportDraft('p2', 'u', { revision: 'two', base: report, local: { ...report, observations: 'Mais recente' } });
    expect(await clearDailyReportDraft('p2', 'u', report.date, 'one')).toBe(false);
    expect((await readDailyReportDrafts('p2', 'u'))[report.date].revision).toBe('two');
    expect(await clearDailyReportDraft('p2', 'u', report.date, 'two')).toBe(true);
    expect(await readDailyReportDrafts('p2', 'u')).toEqual({});
  });
});
