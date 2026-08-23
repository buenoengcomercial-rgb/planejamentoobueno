import { Project } from '@/types/project';
import { listProjects, loadProject, saveProject, setActiveProjectId } from './projectStorage';
import { company } from './companyBranding';

const SIGNATURE = 'obraplanner-backup';
const BACKUP_VERSION = 1;

export interface SingleProjectBackup {
  signature: typeof SIGNATURE;
  kind: 'single';
  version: number;
  exportedAt: string;
  appName: typeof company.productName;
  project: Project;
}

export interface MultiProjectBackup {
  signature: typeof SIGNATURE;
  kind: 'multi';
  version: number;
  exportedAt: string;
  appName: typeof company.productName;
  projects: Project[];
}

export type BackupFile = SingleProjectBackup | MultiProjectBackup;

function todayStamp(): string {
  return new Date().toISOString().split('T')[0];
}

function sanitizeFilename(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'obra';
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportProjectToFile(projectId: string): boolean {
  const project = loadProject(projectId);
  if (!project) return false;
  const backup: SingleProjectBackup = {
    signature: SIGNATURE,
    kind: 'single',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appName: company.productName,
    project,
  };
  downloadJson(`backup_obra_${sanitizeFilename(project.name)}_${todayStamp()}.json`, backup);
  return true;
}

export function exportAllProjectsToFile(): boolean {
  const metas = listProjects();
  const projects: Project[] = [];
  for (const m of metas) {
    const p = loadProject(m.id);
    if (p) projects.push(p);
  }
  if (projects.length === 0) return false;
  const backup: MultiProjectBackup = {
    signature: SIGNATURE,
    kind: 'multi',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appName: company.productName,
    projects,
  };
  downloadJson(`backup_bueno_gestor_de_obras_${todayStamp()}.json`, backup);
  return true;
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function isProject(p: unknown): p is Project {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.name === 'string'
    && Array.isArray(o.phases);
}

export function parseBackup(raw: string): BackupFile | null {
  try {
    const data = JSON.parse(raw);
    if (!data || data.signature !== SIGNATURE) return null;
    if (data.kind === 'single' && isProject(data.project)) {
      return data as SingleProjectBackup;
    }
    if (data.kind === 'multi' && Array.isArray(data.projects) && data.projects.every(isProject)) {
      return data as MultiProjectBackup;
    }
    return null;
  } catch {
    return null;
  }
}

export interface ProjectSummary {
  name: string;
  chapterCount: number;
  taskCount: number;
  measurementCount: number;
  startDate?: string;
  endDate?: string;
}

function countTasks(tasks: { children?: unknown[] }[] = []): number {
  let n = 0;
  for (const t of tasks) {
    n++;
    const children = (t as { children?: unknown[] }).children;
    if (Array.isArray(children)) n += countTasks(children as { children?: unknown[] }[]);
  }
  return n;
}

export function summarizeProject(p: Project): ProjectSummary {
  const chapterCount = (p.phases || []).length;
  let taskCount = 0;
  for (const ph of p.phases || []) {
    taskCount += countTasks(ph.tasks || []);
  }
  return {
    name: p.name,
    chapterCount,
    taskCount,
    measurementCount: (p.measurements || []).length,
    startDate: p.startDate,
    endDate: p.endDate,
  };
}

function uniqueName(desired: string): string {
  const taken = new Set(listProjects().map(p => p.name));
  if (!taken.has(desired)) return desired;
  const base = `${desired} (importada)`;
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/** Importa um projeto, gerando novo id e nome único. Retorna o projeto salvo. */
export function importProject(project: Project, opts: { activate?: boolean } = {}): Project {
  const cloned: Project = JSON.parse(JSON.stringify(project));
  cloned.id = `project-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  cloned.name = uniqueName(cloned.name || 'Obra importada');
  saveProject(cloned);
  if (opts.activate) setActiveProjectId(cloned.id);
  return cloned;
}

export function importAllProjects(projects: Project[]): Project[] {
  const saved: Project[] = [];
  for (const p of projects) {
    saved.push(importProject(p));
  }
  return saved;
}
