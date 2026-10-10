import type { MeasurementWorkspace } from './measurementWorkspace';
import { prepareIncorporation, verifyIncorporationBackup, type IncorporationBackup } from './measurementIncorporation';

export interface WorkspaceDraft { projectId: string; measurementId: string; serviceId: string; rowId: string; changes: Record<string, unknown> }
export interface PendingMeasurementSave { baseRevision: number; candidate: MeasurementWorkspace; archivedAt?: string }
export interface MeasurementRepository {
  load(): Promise<MeasurementWorkspace | null>;
  initialize(backup: IncorporationBackup): Promise<MeasurementWorkspace>;
  commit(candidate: MeasurementWorkspace, baseRevision: number): Promise<MeasurementWorkspace>;
  pending(): Promise<PendingMeasurementSave | null>;
  pendingSaves(): Promise<PendingMeasurementSave[]>;
  archivePending(operationId: string): Promise<void>;
  drafts(): Promise<WorkspaceDraft[]>;
  writeDraft(draft: WorkspaceDraft): Promise<void>;
  clearDraft(measurementId: string, serviceId: string, rowId?: string): Promise<void>;
  backup(): Promise<IncorporationBackup | null>;
}

/** Independent database; Project persistence and its undo cannot address these stores.
 * In this delivery local-isolated scopes ONLY. Never silently fall back from cloud.
 */
export function measurementRepository(scope: { environment: 'isolated'; userId: string; projectId: string }): MeasurementRepository {
  if (scope.environment !== 'isolated' || !scope.userId || !scope.projectId) throw new Error('Ativação operacional indisponível até validar o servidor e a incorporação.');
  const key = JSON.stringify([scope.userId, scope.projectId]);
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('measurement-workspace-v1', 1);
    request.onupgradeneeded = () => ['workspaces', 'backups', 'pending', 'drafts'].forEach(name => request.result.createObjectStore(name));
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const read = async <T>(name: string): Promise<T | null> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readonly'), request = tx.objectStore(name).get(key);
      tx.oncomplete = () => { db.close(); resolve(request.result ?? null); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  };
  const update = async <T>(name: string, edit: (current: T | null) => T) => {
    const db = await open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite'), store = tx.objectStore(name), request = store.get(key);
      request.onsuccess = () => { try { store.put(edit(request.result ?? null), key); } catch (error) { tx.abort(); reject(error); } };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Gravação local interrompida.')); };
    });
  };
  return {
    load: async () => {
      const value = await read<MeasurementWorkspace>('workspaces');
      if (value && (value.schema !== 1 || value.projectId !== scope.projectId || !Array.isArray(value.entries) || !Array.isArray(value.periods) || !Array.isArray(value.plans))) throw new Error('Base incompleta ou incompatível. Edição bloqueada.');
      return value;
    },
    backup: () => read<IncorporationBackup>('backups'),
    pending: async () => (await read<PendingMeasurementSave[]>('pending'))?.find(p => !p.archivedAt) ?? null,
    pendingSaves: async () => await read<PendingMeasurementSave[]>('pending') ?? [],
    archivePending: operationId => update<PendingMeasurementSave[]>('pending', rows => (rows ?? []).map(p => p.candidate.audit.at(-1)?.id === operationId ? { ...p, archivedAt: new Date().toISOString() } : p)),
    drafts: async () => await read<WorkspaceDraft[]>('drafts') ?? [],
    writeDraft: draft => {
      if (draft.projectId !== scope.projectId) return Promise.reject(new Error('Rascunho pertence a outra obra.'));
      return update<WorkspaceDraft[]>('drafts', rows => {
        const existing = (rows ?? []).find(r => r.measurementId === draft.measurementId && r.serviceId === draft.serviceId && r.rowId === draft.rowId);
        return [...(rows ?? []).filter(r => r !== existing), { ...draft, changes: { ...existing?.changes, ...draft.changes } }];
      });
    },
    clearDraft: (mid, sid, rid) => update<WorkspaceDraft[]>('drafts', rows => (rows ?? []).filter(r => !(r.measurementId === mid && r.serviceId === sid && (!rid || r.rowId === rid)))),
    initialize: async backup => {
      await verifyIncorporationBackup(backup);
      if (backup.project.id !== scope.projectId) throw new Error('Backup pertence a outra obra.');
      const plan = prepareIncorporation(backup);
      if (plan.issues.length) throw new Error(`Incorporação bloqueada: ${plan.issues.length} pendência(s) de conciliação.`);
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['workspaces', 'backups'], 'readwrite');
        const store = tx.objectStore('workspaces'), request = store.get(key); let confirmed = plan.candidate;
        request.onsuccess = () => {
          const existing = request.result as MeasurementWorkspace | undefined;
          if (existing) {
            if (existing.backupId !== backup.id) { tx.abort(); reject(new Error('A base já foi incorporada. Importação externa não pode substituí-la.')); return; }
            confirmed = existing; return;
          }
          tx.objectStore('backups').put(backup, key); store.put(plan.candidate, key);
        };
        tx.oncomplete = () => { db.close(); resolve(confirmed); };
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Incorporação não confirmada.')); };
      });
    },
    commit: async (candidate, baseRevision) => {
      if (candidate.projectId !== scope.projectId || candidate.revision !== baseRevision + 1) throw new Error('Revisão ou obra inválida.');
      // A durable recovery record precedes the atomic aggregate write.
      const operationId = candidate.audit.at(-1)!.id;
      await update<PendingMeasurementSave[]>('pending', rows => [...(rows ?? []).filter(r => r.candidate.audit.at(-1)?.id !== operationId), { baseRevision, candidate }]);
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['workspaces', 'pending'], 'readwrite');
        const store = tx.objectStore('workspaces'), request = store.get(key);
        request.onsuccess = () => {
          const current = request.result as MeasurementWorkspace | undefined;
          if (!current || current.revision !== baseRevision) { tx.abort(); reject(new Error('Conflito: a base mudou em outra janela. Seu rascunho foi preservado; recarregue e confira antes de reaplicar.')); return; }
          if (current.backupId !== candidate.backupId || candidate.audit.length !== current.audit.length + 1 || current.audit.some((a, i) => a.id !== candidate.audit[i]?.id)) { tx.abort(); reject(new Error('Histórico ou origem incompatível.')); return; }
          try {
            store.put(candidate, key);
            const pendingStore = tx.objectStore('pending'), pendingRequest = pendingStore.get(key);
            pendingRequest.onsuccess = () => pendingStore.put((pendingRequest.result as PendingMeasurementSave[] ?? []).filter(r => r.candidate.audit.at(-1)?.id !== operationId), key);
          } catch (error) { tx.abort(); reject(error); }
        };
        tx.oncomplete = () => { db.close(); resolve(candidate); };
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Falha ao salvar. Rascunho preservado.')); };
      });
    },
  };
}
