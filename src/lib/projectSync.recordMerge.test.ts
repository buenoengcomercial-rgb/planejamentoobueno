import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { hasProjectMetadataChanges, mergeProjectRecordsThreeWay } from '@/lib/projectSync';

const base = {
  id: 'project-1', name: 'Obra',
  additives: [
    { id: 'local-id', name: 'Local antigo' },
    { id: 'remote-id', name: 'Remoto antigo' },
  ],
  phases: [{
    id: 'chapter-1', name: 'Capítulo', order: 1,
    tasks: [
      { id: 'task-local', name: 'Local', startDate: '2026-09-30', duration: 1, percentComplete: 0, dailyLogs: [] },
      { id: 'task-remote', name: 'Remota', startDate: '2026-09-30', duration: 1, percentComplete: 0, dailyLogs: [] },
    ],
  }],
} as Project;

describe('mesclagem segura por registro', () => {
  it('não confunde a ordem das propriedades JSON com alteração dos metadados', () => {
    const sameMetadata = { ...base, additives: [...base.additives!] };
    expect(hasProjectMetadataChanges(base, sameMetadata)).toBe(false);
  });

  it('preserva edições simultâneas em IDs distintos', () => {
    const local = { ...base, additives: base.additives!.map(item => item.id === 'local-id' ? { ...item, name: 'Local editado' } : item) };
    const remote = { ...base, additives: base.additives!.map(item => item.id === 'remote-id' ? { ...item, name: 'Remoto editado' } : item) };
    const merged = mergeProjectRecordsThreeWay(base, local, remote, ['additives']);
    expect(merged?.additives?.map(item => item.name)).toEqual(['Local editado', 'Remoto editado']);
  });

  it('recusa duas versões do mesmo registro', () => {
    const local = { ...base, additives: [{ ...base.additives![0], name: 'Local editado' }, base.additives![1]] };
    const remote = { ...base, additives: [{ ...base.additives![0], name: 'Remoto editado' }, base.additives![1]] };
    expect(mergeProjectRecordsThreeWay(base, local, remote, ['additives'])).toBeNull();
  });

  it('mescla tarefas diferentes preservando a árvore e os apontamentos', () => {
    const local = {
      ...base,
      phases: base.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task =>
        task.id === 'task-local' ? { ...task, percentComplete: 25 } : task) })),
    };
    const remote = {
      ...base,
      phases: base.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task =>
        task.id === 'task-remote' ? { ...task, percentComplete: 50 } : task) })),
    };
    const merged = mergeProjectRecordsThreeWay(base, local, remote, ['eapChapters', 'tasks', 'taskDailyLogs']);
    expect(merged?.phases[0].tasks.map(task => task.percentComplete)).toEqual([25, 50]);
    expect(merged?.phases[0].tasks.map(task => task.dailyLogs)).toEqual([[], []]);
  });
});
