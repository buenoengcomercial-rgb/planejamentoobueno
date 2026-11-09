import { sampleProject } from '@/data/sampleProject';
import type { CloudProjectMeta } from '@/lib/cloudProjects';
import type { ProjectMeta } from '@/lib/projectStorage';
import type { Project } from '@/types/project';

const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');

/** Only independent browser projects need the legacy cloud import. */
export function localProjectsNeedingMigration(
  local: ProjectMeta[],
  cloud: CloudProjectMeta[],
  load: (id: string) => Project | null,
): ProjectMeta[] {
  const cloudIds = new Set(cloud.map(project => project.id));
  const cloudNames = new Set(cloud.map(project => normalizeName(project.name)));
  const candidateNames = new Set<string>();
  return local.filter(meta => {
    const project = load(meta.id);
    if (!project) return false;
    if (project.id === sampleProject.id && JSON.stringify(project) === JSON.stringify(sampleProject)) return false;
    const name = normalizeName(project.name);
    if (!name || cloudIds.has(project.id) || cloudNames.has(name) || candidateNames.has(name)) return false;
    candidateNames.add(name);
    return true;
  });
}
