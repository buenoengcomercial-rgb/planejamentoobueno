import type { MutableRefObject } from 'react';
import { toast } from 'sonner';
import type { AppView, Project } from '@/types/project';
import {
  confirmCloudProjectRecord, deleteCloudProject, deleteCloudProjectAsOwner,
  discardCloudProjectRecord, duplicateCloudProject, loadCloudProjectRecord,
  renameCloudProject, upsertCloudProject, type CloudProjectMeta, type CloudProjectRecord,
} from '@/lib/cloudProjects';
import { preloadIndexedDbProjectDraft } from '@/lib/cloudDraftIndexedDb';
import { projectCollectionsForView, readWarehouseTab, type WarehouseTab } from '@/lib/projectDataScope';
import { includePendingDraftCollections } from './projectBootstrap';

export function createDraftProject(name = ''): Project {
  const today = new Date().toISOString().split('T')[0];
  return { id: crypto.randomUUID(), name, startDate: today, endDate: today, phases: [], totalBudget: 0 };
}

interface ProjectLifecycleContext {
  orgId: string | null;
  creator: boolean;
  editor: boolean;
  remover: boolean;
  cloudList: CloudProjectMeta[];
  activeProjectId: string | null;
  getActiveProjectId: () => string | null;
  safeCurrentView: AppView;
  canViewWarehousePanel: boolean;
  owner: boolean;
  projectOpenSequenceRef: MutableRefObject<number>;
  runProtectedNavigation: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  refreshCloudList: () => Promise<CloudProjectMeta[]>;
  replaceProjectWithoutAutoSave: (
    project: Project, updatedAt: string, repairApplied: boolean,
    inspectDraft: boolean, warehouseVersion: number | null,
  ) => void;
  setWarehouseTab: (tab: WarehouseTab) => void;
  showCreateDialog: (draft: Project) => void;
  finishImportedProject: () => void;
  resetUndo: () => void;
  markUndoChanged: () => void;
}

/** Project-level commands; navigation and state adoption stay behind the caller's safety barrier. */
export function createProjectLifecycleHandlers(context: ProjectLifecycleContext) {
  const {
    orgId, creator, editor, remover, cloudList, activeProjectId, getActiveProjectId, safeCurrentView,
    canViewWarehousePanel, owner, projectOpenSequenceRef, runProtectedNavigation,
    refreshCloudList, replaceProjectWithoutAutoSave, setWarehouseTab,
    showCreateDialog, finishImportedProject, resetUndo, markUndoChanged,
  } = context;

  const loadForCurrentView = async (id: string): Promise<CloudProjectRecord | null> => {
    await preloadIndexedDbProjectDraft(id);
    const tab = readWarehouseTab(id, canViewWarehousePanel, owner);
    setWarehouseTab(tab);
    return loadCloudProjectRecord(id, {
      collections: includePendingDraftCollections(id, projectCollectionsForView(safeCurrentView, tab)),
      strict: true,
      deferSnapshot: true,
    });
  };

  const adopt = (record: CloudProjectRecord, updatedAt = record.updatedAt, repairApplied = record.repairApplied) => {
    confirmCloudProjectRecord(record);
    replaceProjectWithoutAutoSave(record.project, updatedAt, repairApplied, true, record.warehouseVersion);
  };

  const switchProject = async (id: string) => {
    try {
      await runProtectedNavigation(async () => {
        const openSequence = ++projectOpenSequenceRef.current;
        await preloadIndexedDbProjectDraft(id);
        if (openSequence !== projectOpenSequenceRef.current) return;
        const nextWarehouseTab = readWarehouseTab(id, canViewWarehousePanel, owner);
        setWarehouseTab(nextWarehouseTab);
        const record = await loadCloudProjectRecord(id, {
          collections: includePendingDraftCollections(id, projectCollectionsForView(safeCurrentView, nextWarehouseTab)),
          strict: true,
          deferSnapshot: true,
        });
        if (openSequence !== projectOpenSequenceRef.current) {
          if (record) discardCloudProjectRecord(record);
          return;
        }
        if (record) adopt(record);
      });
    } catch {
      toast.error('Erro ao abrir obra');
    }
  };

  const createProject = async (): Promise<void> => {
    if (!orgId) return;
    if (!creator) { toast.error('Sem permissão para criar obras.'); return; }
    try {
      await runProtectedNavigation(async () => showCreateDialog(createDraftProject()));
    } catch {
      toast.error('Erro ao criar obra');
    }
  };

  const createProjectFromImport = async (projectToCreate: Project) => {
    if (!orgId) throw new Error('Empresa nao identificada para salvar a obra.');
    if (!creator) throw new Error('Sem permissao para criar obras.');
    const finalName = projectToCreate.name.trim();
    if (!finalName) throw new Error('Informe o nome da obra.');
    if (cloudList.some(p => p.name.trim().toLowerCase() === finalName.toLowerCase())) {
      throw new Error('Ja existe uma obra com este nome. Informe outro nome.');
    }
    const projectWithName = { ...projectToCreate, name: finalName };
    const updatedAt = await upsertCloudProject(projectWithName, orgId);
    const persisted = await loadCloudProjectRecord(projectWithName.id, { strict: true, deferSnapshot: true });
    if (!persisted) throw new Error('A obra foi gravada, mas nao pode ser relida para validacao.');
    const taskCount = (project: Project) => (project.phases ?? []).reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
    const collectionsMatch =
      (persisted.project.budgetItems?.length ?? 0) === (projectWithName.budgetItems?.length ?? 0)
      && (persisted.project.analyticCompositions?.length ?? 0) === (projectWithName.analyticCompositions?.length ?? 0)
      && (persisted.project.phases?.length ?? 0) === (projectWithName.phases?.length ?? 0)
      && taskCount(persisted.project) === taskCount(projectWithName);
    if (!collectionsMatch) {
      discardCloudProjectRecord(persisted);
      await deleteCloudProject(projectWithName.id);
      throw new Error('A estrutura importada nao foi confirmada no banco. A obra incompleta foi removida; tente novamente.');
    }
    const list = await refreshCloudList();
    adopt(persisted, list.find(p => p.id === projectWithName.id)?.updatedAt ?? persisted.updatedAt ?? updatedAt, false);
    resetUndo();
    markUndoChanged();
    finishImportedProject();
    toast.success('Obra criada e planilha importada com sucesso.');
  };

  const renameProject = async (id: string, newName: string, expectedName: string) => {
    if (!orgId || !editor) { toast.error('Sem permissão para renomear.'); return; }
    try {
      await runProtectedNavigation(async () => {
        const updated = await renameCloudProject(id, newName, orgId, expectedName);
        if (updated) {
          if (getActiveProjectId() === id) adopt(updated);
          else discardCloudProjectRecord(updated);
        }
        await refreshCloudList();
        markUndoChanged();
      });
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erro ao renomear');
      return false;
    }
  };

  const duplicateProject = async (id: string) => {
    if (!orgId || !creator) { toast.error('Sem permissão para duplicar.'); return; }
    try {
      await runProtectedNavigation(async () => {
        const copy = await duplicateCloudProject(id, orgId);
        if (copy) {
          await refreshCloudList();
          toast.success(`Obra duplicada: ${copy.name}`);
          markUndoChanged();
        }
      });
    } catch {
      toast.error('Erro ao duplicar');
    }
  };

  const deleteProject = async (id: string, password: string): Promise<boolean> => {
    if (!remover) { toast.error('Somente o Proprietário pode excluir obras.'); return false; }
    if (cloudList.length <= 1) { toast.error('Não é possível excluir a única obra. Crie outra antes.'); return false; }
    try {
      const deleted = await runProtectedNavigation(async () => {
        await deleteCloudProjectAsOwner(id, password);
        const list = await refreshCloudList();
        if (activeProjectId === id) {
          const next = list[0];
          if (next) {
            const record = await loadForCurrentView(next.id);
            if (record) { adopt(record); resetUndo(); }
          }
        }
        toast.success('Obra excluída');
        markUndoChanged();
        return true;
      });
      return deleted ?? false;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erro ao excluir a obra.');
      return false;
    }
  };

  return { switchProject, createProject, createProjectFromImport, renameProject, duplicateProject, deleteProject };
}
