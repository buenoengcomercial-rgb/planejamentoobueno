import { describe, expect, it } from 'vitest';
import type { DailyReport } from '@/types/project';
import { mergeDailyReportVersions } from './dailyReportCloudSync';

const base = (): DailyReport => ({
  id: 'dr-1', date: '2026-09-10', createdAt: '2026-09-10T08:00:00.000Z', updatedAt: '2026-09-10T08:00:00.000Z',
  attachments: [{ id: 'photo-1', caption: '' }], teamsPresent: [], equipment: [],
});

describe('mergeDailyReportVersions', () => {
  it('mescla uma legenda local com observação alterada remotamente', () => {
    const initial = base();
    const local = { ...initial, updatedAt: '2026-09-10T08:01:00.000Z', attachments: [{ id: 'photo-1', caption: 'Foto da instalação' }] };
    const remote = { ...initial, updatedAt: '2026-09-10T08:02:00.000Z', observations: 'Equipe aguardou liberação.' };

    const result = mergeDailyReportVersions(initial, local, remote);

    expect(result.conflicts).toEqual([]);
    expect(result.report.attachments?.[0].caption).toBe('Foto da instalação');
    expect(result.report.observations).toBe('Equipe aguardou liberação.');
  });

  it('mantém a primeira legenda quando a mesma foto é alterada simultaneamente', () => {
    const initial = base();
    const local = { ...initial, attachments: [{ id: 'photo-1', caption: 'Legenda do segundo aparelho' }] };
    const remote = { ...initial, attachments: [{ id: 'photo-1', caption: 'Legenda já salva' }] };

    const result = mergeDailyReportVersions(initial, local, remote);

    expect(result.conflicts).toContain('attachments.photo-1.caption');
    expect(result.report.attachments?.[0].caption).toBe('Legenda já salva');
  });

  it('preserva fotos incluídas em aparelhos diferentes', () => {
    const initial = base();
    const local = { ...initial, attachments: [...initial.attachments!, { id: 'photo-local', caption: 'Local' }] };
    const remote = { ...initial, attachments: [...initial.attachments!, { id: 'photo-remota', caption: 'Remota' }] };

    const result = mergeDailyReportVersions(initial, local, remote);

    expect(result.report.attachments?.map(photo => photo.id)).toEqual(['photo-1', 'photo-remota', 'photo-local']);
  });
});
