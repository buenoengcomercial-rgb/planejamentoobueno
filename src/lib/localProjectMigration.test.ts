import { describe, expect, it } from 'vitest';
import { sampleProject } from '@/data/sampleProject';
import { localProjectsNeedingMigration } from './localProjectMigration';
import type { Project } from '@/types/project';

const meta = (id: string, name: string) => ({ id, name, createdAt: '', updatedAt: '' });
const cloud = (id: string, name: string) => ({ id, name, createdAt: '', updatedAt: '' });

describe('legacy project migration candidates', () => {
  it('does not offer the bundled example or an already cloud saved work', () => {
    const projects = [sampleProject, { ...sampleProject, id: 'local-1', name: 'Palácio Rio Madeira' }];
    expect(localProjectsNeedingMigration(
      projects.map(project => meta(project.id, project.name)),
      [cloud('cloud-1', '  PALÁCIO  RIO MADEIRA  ')],
      id => projects.find(project => project.id === id) ?? null,
    )).toEqual([]);
  });

  it('offers only a distinct local work and ignores missing browser records', () => {
    const project = { ...sampleProject, id: 'local-2', name: 'Obra independente' } as Project;
    const duplicate = { ...project, id: 'local-3', name: ' OBRA  INDEPENDENTE ' };
    expect(localProjectsNeedingMigration(
      [meta('local-2', project.name), meta('local-3', duplicate.name), meta('missing', 'Perdida')], [],
      id => id === project.id ? project : id === duplicate.id ? duplicate : null,
    )).toEqual([meta('local-2', project.name)]);
  });
});
