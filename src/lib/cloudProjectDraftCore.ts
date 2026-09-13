import type { Project } from '@/types/project';

export const PROJECT_DRAFT_VERSION = 2 as const;
export const LEGACY_PROJECT_DRAFT_VERSION = 1 as const;

export interface StoredProjectDraft {
  version: number;
  baseUpdatedAt: string | null;
  savedAt?: string;
  localDraftUpdatedAt: string;
  project: Project;
}

export type ProjectDraftInspection =
  | { kind: 'none'; reason: 'missing' | 'invalid' }
  | { kind: 'identical'; draft: StoredProjectDraft }
  | { kind: 'recoverable'; draft: StoredProjectDraft }
  | { kind: 'candidate'; draft: StoredProjectDraft; reason: 'legacy' | 'cloud_changed' };

export type RemoteVersionAction = 'current' | 'reload' | 'conflict';

export const projectDraftKey = (projectId: string) => `obraplanner:unsaved-cloud-draft:${projectId}`;

// Depois de uma QuotaExceededError, insistir em novas gravações no mesmo
// armazenamento só repete uma operação síncrona cara durante a digitação.
// A cópia local é complementar: a nuvem permanece sendo a fonte confirmada.
const storageWithUnavailableDraftQuota = new WeakSet<Storage>();

function withoutEmbeddedBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmbeddedBinary);
  if (!value || typeof value !== 'object') return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'dataUrl' && typeof entry === 'string' && entry.startsWith('data:')) continue;
    sanitized[key] = withoutEmbeddedBinary(entry);
  }
  return sanitized;
}

export function sanitizeProjectDraft(project: Project): Project {
  return withoutEmbeddedBinary(project) as Project;
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project);
}

function defaultStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

export function readStoredProjectDraft(projectId: string, storage: Storage | null = defaultStorage()): StoredProjectDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(projectDraftKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredProjectDraft>;
    if (!parsed.project || parsed.project.id !== projectId || typeof parsed.version !== 'number') return null;
    const localDraftUpdatedAt = parsed.localDraftUpdatedAt ?? parsed.savedAt;
    if (!localDraftUpdatedAt) return null;
    return {
      version: parsed.version,
      baseUpdatedAt: parsed.baseUpdatedAt ?? null,
      savedAt: parsed.savedAt,
      localDraftUpdatedAt,
      project: parsed.project,
    };
  } catch {
    return null;
  }
}

export function inspectProjectDraft(
  cloudProject: Project,
  cloudUpdatedAt: string | null,
  storage: Storage | null = defaultStorage(),
): ProjectDraftInspection {
  const draft = readStoredProjectDraft(cloudProject.id, storage);
  if (!draft) return { kind: 'none', reason: 'missing' };
  if (serializeProject(draft.project) === serializeProject(cloudProject)) return { kind: 'identical', draft };
  if (draft.version !== PROJECT_DRAFT_VERSION) return { kind: 'candidate', draft, reason: 'legacy' };
  if (draft.baseUpdatedAt !== cloudUpdatedAt) return { kind: 'candidate', draft, reason: 'cloud_changed' };
  return { kind: 'recoverable', draft };
}

export function writeProjectDraft(
  project: Project,
  baseUpdatedAt: string | null,
  storage: Storage | null = defaultStorage(),
): StoredProjectDraft | null {
  if (!storage) return null;
  if (storageWithUnavailableDraftQuota.has(storage)) return null;
  const now = new Date().toISOString();
  const safeProject = sanitizeProjectDraft(project);
  const draft: StoredProjectDraft = {
    version: PROJECT_DRAFT_VERSION,
    baseUpdatedAt,
    savedAt: now,
    localDraftUpdatedAt: now,
    project: safeProject,
  };
  try {
    storage.setItem(projectDraftKey(project.id), JSON.stringify(draft));
    return draft;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      storageWithUnavailableDraftQuota.add(storage);
    }
    console.warn('[cloudProjectDrafts] Não foi possível proteger o rascunho local.', error);
    return null;
  }
}

export function clearProjectDraft(projectId: string, storage: Storage | null = defaultStorage()): void {
  storage?.removeItem(projectDraftKey(projectId));
}

export function projectHasLocalChanges(
  project: Project | null,
  lastSavedProjectJson: string | null,
  savePending = false,
): boolean {
  if (!project) return false;
  if (savePending) return true;
  return lastSavedProjectJson == null || serializeProject(project) !== lastSavedProjectJson;
}

export function resolveRemoteVersionAction(
  remoteUpdatedAt: string | null | undefined,
  currentUpdatedAt: string | null | undefined,
  hasLocalChanges: boolean,
): RemoteVersionAction {
  if (!remoteUpdatedAt || remoteUpdatedAt === currentUpdatedAt) return 'current';
  return hasLocalChanges ? 'conflict' : 'reload';
}
