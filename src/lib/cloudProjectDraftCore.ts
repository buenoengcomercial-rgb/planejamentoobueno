import type { Project } from '@/types/project';
import { mergeConcurrentFields, sameJsonStructure } from '@/lib/concurrentFields';
import type { ProjectCollectionKey } from '@/lib/projectDataScope';
import { clearIndexedDbProjectDraft, getCachedIndexedDbProjectDraft } from '@/lib/cloudDraftIndexedDb';

export const PROJECT_DRAFT_VERSION = 2 as const;
export const LEGACY_PROJECT_DRAFT_VERSION = 1 as const;

export interface StoredProjectDraft {
  version: number;
  baseUpdatedAt: string | null;
  savedAt?: string;
  localDraftUpdatedAt: string;
  project: Project;
  /** Confirmed ancestor used to rebase a draft after another device advances the project. */
  baseProject?: Project;
  /** Coleções realmente carregadas quando o rascunho foi criado. */
  pendingNormalizedSync?: boolean;
  loadedCollections?: ProjectCollectionKey[];
}

export interface ProjectDraftWriteOptions {
  pendingNormalizedSync?: boolean;
  loadedCollections?: readonly ProjectCollectionKey[];
  baseProject?: Project | null;
}

export type ProjectDraftInspection =
  | { kind: 'none'; reason: 'missing' | 'invalid' }
  | { kind: 'identical'; draft: StoredProjectDraft }
  | { kind: 'recoverable'; draft: StoredProjectDraft }
  | { kind: 'candidate'; draft: StoredProjectDraft; reason: 'legacy' | 'cloud_changed' };

export type RemoteVersionAction = 'current' | 'reload';

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
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}

export function readStoredProjectDraft(projectId: string, storage: Storage | null = defaultStorage()): StoredProjectDraft | null {
  if (!storage) return getCachedIndexedDbProjectDraft(projectId);
  let local: StoredProjectDraft | null = null;
  try {
    const raw = storage.getItem(projectDraftKey(projectId));
    if (!raw) return getCachedIndexedDbProjectDraft(projectId);
    const parsed = JSON.parse(raw) as Partial<StoredProjectDraft>;
    if (!parsed.project || parsed.project.id !== projectId || typeof parsed.version !== 'number') return getCachedIndexedDbProjectDraft(projectId);
    const localDraftUpdatedAt = parsed.localDraftUpdatedAt ?? parsed.savedAt;
    if (!localDraftUpdatedAt) return getCachedIndexedDbProjectDraft(projectId);
    local = {
      version: parsed.version,
      baseUpdatedAt: parsed.baseUpdatedAt ?? null,
      savedAt: parsed.savedAt,
      localDraftUpdatedAt,
      project: parsed.project,
      baseProject: parsed.baseProject?.id === projectId ? parsed.baseProject : undefined,
      pendingNormalizedSync: parsed.pendingNormalizedSync === true,
      loadedCollections: Array.isArray(parsed.loadedCollections)
        ? parsed.loadedCollections
        : undefined,
    };
  } catch {
    return getCachedIndexedDbProjectDraft(projectId);
  }
  const indexed = getCachedIndexedDbProjectDraft(projectId);
  return indexed && indexed.localDraftUpdatedAt > (local?.localDraftUpdatedAt ?? '') ? indexed : local;
}

export function createProjectDraft(
  project: Project,
  baseUpdatedAt: string | null,
  options: ProjectDraftWriteOptions = {},
): StoredProjectDraft {
  const now = new Date().toISOString();
  return {
    version: PROJECT_DRAFT_VERSION,
    baseUpdatedAt,
    savedAt: now,
    localDraftUpdatedAt: now,
    project: sanitizeProjectDraft(project),
    baseProject: options.baseProject?.id === project.id
      ? sanitizeProjectDraft(options.baseProject)
      : undefined,
    pendingNormalizedSync: options.pendingNormalizedSync === true || undefined,
    loadedCollections: options.loadedCollections?.length
      ? [...new Set<ProjectCollectionKey>([...options.loadedCollections, ...(project.auditLogs?.length ? ['auditLogs' as const] : [])])]
      : undefined,
  };
}

export function inspectProjectDraft(
  cloudProject: Project,
  cloudUpdatedAt: string | null,
  storage: Storage | null = defaultStorage(),
  hasLoadedDraftCollections?: (collections: readonly ProjectCollectionKey[]) => boolean,
): ProjectDraftInspection {
  const draft = readStoredProjectDraft(cloudProject.id, storage);
  if (!draft) return { kind: 'none', reason: 'missing' };
  if (!draft.pendingNormalizedSync) {
    const missingDraftCollections = draft.loadedCollections?.length
      && hasLoadedDraftCollections?.(draft.loadedCollections) === false;
    if (!missingDraftCollections && sameJsonStructure(draft.project, cloudProject)) return { kind: 'identical', draft };
    const base = draft.baseProject;
    if (base?.id === cloudProject.id) {
      const cloudIsNewer = !!cloudUpdatedAt && Date.parse(cloudUpdatedAt) > Date.parse(draft.localDraftUpdatedAt);
      if (cloudIsNewer && sameJsonStructure(draft.project, base)) return { kind: 'identical', draft };
      if (draft.baseUpdatedAt !== cloudUpdatedAt && draft.loadedCollections?.length
        && hasLoadedDraftCollections?.(draft.loadedCollections)) {
        const merged = mergeConcurrentFields(base, draft.project, cloudProject);
        if (merged.conflicts.length === 0 && sameJsonStructure(merged.value, cloudProject)) {
          return { kind: 'identical', draft };
        }
      }
    }
  }
  if (draft.version !== PROJECT_DRAFT_VERSION) return { kind: 'candidate', draft, reason: 'legacy' };
  if (draft.baseUpdatedAt !== cloudUpdatedAt) return { kind: 'candidate', draft, reason: 'cloud_changed' };
  return { kind: 'recoverable', draft };
}

export function writeProjectDraft(
  project: Project,
  baseUpdatedAt: string | null,
  storage: Storage | null = defaultStorage(),
  options: ProjectDraftWriteOptions = {},
): StoredProjectDraft | null {
  if (!storage) return null;
  if (storageWithUnavailableDraftQuota.has(storage)) return null;
  const draft = createProjectDraft(project, baseUpdatedAt, options);
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

export function clearProjectDraft(projectId: string, storage: Storage | null = defaultStorage()): Promise<void> {
  try { storage?.removeItem(projectDraftKey(projectId)); }
  catch { /* IndexedDB must still be cleared when localStorage is unavailable. */ }
  return storage === defaultStorage() ? clearIndexedDbProjectDraft(projectId) : Promise.resolve();
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
): RemoteVersionAction {
  if (!remoteUpdatedAt || remoteUpdatedAt === currentUpdatedAt) return 'current';
  // A timestamp advance requires a read, not a conflict decision. Only a
  // three-way comparison can identify a collision in an edited field.
  return 'reload';
}
