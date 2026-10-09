import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyReport, Project } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import { supabase } from '@/integrations/supabase/client';
import { registerPendingForm } from '@/lib/pendingFormNavigation';
import {
  projectDraftKey,
  readStoredProjectDraft,
  writeProjectDraft,
} from '@/lib/cloudProjectDraftCore';

const mocks = vi.hoisted(() => ({
  listCloudProjects: vi.fn(),
  loadCloudProjectRecord: vi.fn(),
  upsertCloudProject: vi.fn(),
  getCloudProjectVersion: vi.fn(),
  realtimeHandlers: [] as Array<{
    table: string;
    callback: (payload: { new?: Record<string, unknown> | null; old?: Record<string, unknown> | null }) => void;
  }>,
  commitWarehouseOperation: vi.fn(),
  warehouseUpload: vi.fn(),
  saveOpenDailyReport: vi.fn(),
  loadOpenDailyReport: vi.fn(),
  signOut: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn(),
  toastWarning: vi.fn(),
  user: { id: 'owner-1', email: 'owner@example.com', user_metadata: { name: 'Owner' } },
  membership: {
    organization: { id: 'org-1', name: 'Organização', cnpj: null },
    role: 'owner',
    status: 'active',
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mocks.user,
    loading: false,
    signOut: mocks.signOut,
  }),
}));

vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    membership: mocks.membership,
    loading: false,
    reload: vi.fn(),
  }),
}));

vi.mock('@/lib/cloudProjects', () => {
  class MockCloudProjectConflictError extends Error {}
  class MockCloudProjectPartialSyncError extends Error {
    updatedAt: string;
    detail: unknown;
    cause: unknown;

    constructor(updatedAt: string, detail: unknown) {
      super('partial sync');
      this.updatedAt = updatedAt;
      this.detail = detail;
      this.cause = detail;
    }
  }

  return {
    CloudProjectConflictError: MockCloudProjectConflictError,
    CloudProjectPartialSyncError: MockCloudProjectPartialSyncError,
    listCloudProjects: mocks.listCloudProjects,
    loadCloudProjectRecord: mocks.loadCloudProjectRecord,
    upsertCloudProject: mocks.upsertCloudProject,
    createCloudProject: vi.fn(),
    renameCloudProject: vi.fn(),
    duplicateCloudProject: vi.fn(),
    deleteCloudProject: vi.fn(),
    deleteCloudProjectAsOwner: vi.fn(),
    generateUniqueCloudName: vi.fn(),
    getSampleSeed: vi.fn(),
    getCloudProjectVersion: mocks.getCloudProjectVersion,
    confirmCloudProjectRecord: vi.fn(),
    discardCloudProjectRecord: vi.fn(),
  };
});

vi.mock('@/lib/dailyReportCloudSync', () => ({
  saveOpenDailyReport: mocks.saveOpenDailyReport,
  loadOpenDailyReport: mocks.loadOpenDailyReport,
}));

vi.mock('@/lib/dailyReportDrafts', () => ({
  readDailyReportDrafts: vi.fn(async () => ({})),
  protectDailyReportDraft: vi.fn(async () => undefined),
  clearDailyReportDraft: vi.fn(async () => true),
}));

vi.mock('@/lib/warehouseCloudCommit', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/warehouseCloudCommit')>();
  return {
    ...actual,
    commitWarehouseOperation: mocks.commitWarehouseOperation,
  };
});

vi.mock('@/lib/projectSync', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/projectSync')>();
  return {
    ...actual,
    getMissingProjectCollections: vi.fn(() => []),
    getLoadedProjectCollections: vi.fn(() => ['dailyReports', 'tasks']),
  };
});

vi.mock('@/lib/idlePreload', () => ({ scheduleIdlePreload: vi.fn(() => undefined) }));
vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    message: mocks.toastMessage,
    success: vi.fn(),
    warning: mocks.toastWarning,
  },
}));

vi.mock('@/integrations/supabase/client', () => {
  const channel = {
    on: vi.fn((_: string, config: { table: string }, callback: (payload: { new?: Record<string, unknown> | null; old?: Record<string, unknown> | null }) => void) => {
      mocks.realtimeHandlers.push({ table: config.table, callback });
      return channel;
    }),
    subscribe: vi.fn(() => channel),
  };
  return {
    supabase: {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      storage: { from: vi.fn(() => ({ remove: vi.fn().mockResolvedValue(undefined) })) },
    },
  };
});

vi.mock('@/components/AppSidebar', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ onSwitchProject, onViewChange, onOpenTeam }: { onSwitchProject: (id: string) => void; onViewChange: (view: 'dashboard') => void; onOpenTeam?: () => void }) => createElement(
      'div',
      null,
      createElement('button', { type: 'button', onClick: () => onSwitchProject('project-2') }, 'Trocar obra de teste'),
      createElement('button', { type: 'button', onClick: () => onViewChange('dashboard') }, 'Abrir Dashboard de teste'),
      createElement('button', { type: 'button', onClick: onOpenTeam }, 'Abrir usuários de teste'),
    ),
  };
});

vi.mock('@/components/UndoButton', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ onUndo }: { onUndo: () => void }) => createElement(
      'button',
      { type: 'button', onClick: onUndo },
      'Desfazer no teste',
    ),
  };
});

vi.mock('@/components/DailyProductionWorkspace', async () => {
  const { createElement, useState } = await import('react');
  const DraftInput = () => {
    const [value, setValue] = useState('');
    return createElement('input', {
      'aria-label': 'Rascunho da produção no teste',
      value,
      onChange: (event: { target: { value: string } }) => setValue(event.target.value),
    });
  };
  type Setter = (next: Project | ((current: Project) => Project)) => void;
  interface Props {
    project: Project;
    onProductionChange: Setter;
    onDailyReportChange: Setter;
    productionUndoButton?: ReactNode;
  }
  return {
    default: ({ project, onProductionChange, onDailyReportChange, productionUndoButton }: Props) => createElement(
      'div',
      { 'data-testid': 'project-workspace' },
      createElement('span', { 'data-testid': 'project-name' }, project.name),
      createElement(DraftInput),
      createElement('button', {
        type: 'button',
        onClick: () => onProductionChange(current => ({ ...current, name: 'Alteração geral pendente' })),
      }, 'Alterar projeto'),
      createElement('button', {
        type: 'button',
        onClick: () => onDailyReportChange(current => ({
          ...current,
          dailyReports: (current.dailyReports ?? []).map(report => ({
            id: report.id,
            date: report.date,
            createdAt: report.createdAt,
            updatedAt: report.updatedAt,
            teamsPresent: [],
            equipment: [],
            attachments: [],
          })),
        })),
      }, 'Esvaziar diário'),
      productionUndoButton,
    ),
  };
});

vi.mock('@/components/SaveStatusIndicator', () => ({
  default: ({ confirmedAt }: { confirmedAt?: string | null }) => (
    <output data-testid="cloud-confirmed-at">{confirmedAt ?? 'none'}</output>
  ),
}));
vi.mock('@/components/MigrationDialog', () => ({ default: () => null }));
vi.mock('@/components/ImportSyntheticDialog', () => ({ default: () => null }));
vi.mock('@/components/CloudDraftConflictDialog', async () => {
  const { createElement } = await import('react');
  return { default: () => createElement('div', { role: 'alert' }, 'Conflito de cópia local') };
});

vi.mock('@/components/Dashboard', () => ({ default: () => null }));
vi.mock('@/components/OperationalManagementRoutine', () => ({ default: () => null }));
vi.mock('@/components/OperationalGanttChart', () => ({ default: () => null }));
vi.mock('@/components/Measurement', () => ({ default: () => null }));
vi.mock('@/components/TaskList', () => ({ default: () => null }));
vi.mock('@/components/DailyReport', () => ({ default: () => null }));
vi.mock('@/components/Additive', async () => {
  const { createElement } = await import('react');
  type Setter = (next: Project | ((current: Project) => Project)) => void;
  return {
    default: ({ project, onProjectChange }: { project: Project; onProjectChange: Setter }) => createElement(
      'div',
      { 'data-testid': 'additive-workspace' },
      createElement('span', { 'data-testid': 'additive-count' }, String(project.additives?.length ?? 0)),
      createElement('button', {
        type: 'button',
        onClick: () => onProjectChange(current => ({
          ...current,
          additives: [{
            id: 'additive-local',
            name: 'Alteração local no Aditivo',
            importedAt: '2026-09-14T10:00:00.000Z',
            compositions: [],
          }],
        })),
      }, 'Alterar Aditivo local'),
    ),
  };
});
vi.mock('@/components/AdditiveSchedule', () => ({ default: () => null }));
vi.mock('@/components/RealCost', () => ({ default: () => null }));
vi.mock('@/components/Materials', () => ({ default: () => null }));
vi.mock('@/components/warehouse/Warehouse', async () => {
  const { createElement, useState } = await import('react');
  const DraftInput = () => {
    const [value, setValue] = useState('');
    return createElement('input', {
      'aria-label': 'Rascunho do Almoxarifado no teste',
      value,
      onChange: (event: { target: { value: string } }) => setValue(event.target.value),
    });
  };
  interface Props {
    project: Project;
    isTabDataReady?: boolean;
    onProjectChange: (next: Project | ((current: Project) => Project)) => void;
    onCommitCloudWarehouseOperation?: (
      before: Project,
      after: Project,
      operation: { type: 'delivery'; requisitionId: string; operationKey: string },
    ) => Promise<unknown>;
    onRunCriticalCloudWarehouseOperation?: <T>(operation: () => Promise<T>) => Promise<T>;
  }
  return {
    default: ({ project, isTabDataReady, onProjectChange, onCommitCloudWarehouseOperation, onRunCriticalCloudWarehouseOperation }: Props) => isTabDataReady === false
      ? createElement('div', null, 'Carregando área do Almoxarifado...')
      : createElement(
      'div',
      { 'data-testid': 'warehouse-workspace' },
      createElement(DraftInput),
      createElement('button', {
        type: 'button',
        onClick: () => onProjectChange(current => ({ ...current, name: 'Alteração geral pendente' })),
      }, 'Alterar obra no almoxarifado'),
      createElement('button', {
        type: 'button',
        onClick: () => {
          void onCommitCloudWarehouseOperation?.(project, project, {
            type: 'delivery',
            requisitionId: 'req-test',
            operationKey: 'operation-test',
          }).catch(() => undefined);
        },
      }, 'Iniciar operação do almoxarifado'),
      createElement('button', {
        type: 'button',
        onClick: () => {
          const operation = async () => {
            await mocks.warehouseUpload();
            return onCommitCloudWarehouseOperation?.(project, project, {
              type: 'delivery',
              requisitionId: 'req-photo-test',
              operationKey: 'operation-photo-test',
            });
          };
          void (onRunCriticalCloudWarehouseOperation
            ? onRunCriticalCloudWarehouseOperation(operation)
            : operation()).catch(() => undefined);
        },
      }, 'Iniciar retirada com foto'),
    ),
  };
});

import Index from './Index';
import { CloudProjectConflictError, CloudProjectPartialSyncError } from '@/lib/cloudProjects';

const report: DailyReport = {
  id: 'daily-1',
  date: '2026-09-14',
  createdAt: '2026-09-14T08:00:00.000Z',
  updatedAt: '2026-09-14T08:00:00.000Z',
  teamsPresent: [],
  equipment: [],
  attachments: [],
  observations: 'Registro que será excluído',
};

function makeProject(id = 'project-1'): Project {
  return {
    id,
    name: `Obra ${id}`,
    startDate: '2026-09-01',
    endDate: '2026-12-31',
    phases: [],
    totalBudget: 0,
    dailyReports: [report],
    warehouse: {
      ...emptyWarehouse(),
      fiscalDuplicateReconciliationVersion: 1,
    },
  };
}

function cloudMeta(project: Project, updatedAt = 'cloud-v2') {
  return {
    id: project.id,
    name: project.name,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt,
  };
}

function cloudRecord(project: Project, updatedAt = 'cloud-v2') {
  return {
    project,
    updatedAt,
    warehouseVersion: 1,
    warehouseUpdatedAt: updatedAt,
    loadedCollections: [],
    repairApplied: false,
  };
}

function renderIndex(routeView = 'producao') {
  function RoutePath() {
    const location = useLocation();
    return <span data-testid="route-path">{location.pathname}</span>;
  }
  return render(
    <MemoryRouter initialEntries={[`/obras/project-1/${routeView}`]}>
      <RoutePath />
      <Routes>
        <Route path="/obras/:routeProjectId/:routeView" element={<Index />} />
        <Route path="/team" element={<div data-testid="team-page">Usuários</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  localStorage.clear();
  vi.clearAllMocks();
  mocks.realtimeHandlers.length = 0;
  vi.useRealTimers();
  const first = makeProject();
  const second = makeProject('project-2');
  mocks.listCloudProjects.mockResolvedValue([cloudMeta(first), cloudMeta(second)]);
  mocks.loadCloudProjectRecord.mockImplementation(async (id: string) => (
    id === first.id ? cloudRecord(first) : cloudRecord(second)
  ));
  mocks.upsertCloudProject.mockResolvedValue('cloud-v3');
  mocks.getCloudProjectVersion.mockResolvedValue(null);
  mocks.commitWarehouseOperation.mockReset();
  mocks.warehouseUpload.mockReset();
  mocks.warehouseUpload.mockResolvedValue(undefined);
  mocks.loadOpenDailyReport.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('segurança de sincronização da página da obra', () => {
  it('direciona o antigo link de levantamento para a Produção', async () => {
    renderIndex('levantamento');
    expect(await screen.findByTestId('project-workspace')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('route-path')).toHaveTextContent('/obras/project-1/producao'));
  });

  it('não restaura a rolagem como se a página tivesse reiniciado ao editar o Diário', async () => {
    mocks.saveOpenDailyReport.mockResolvedValue({ report: null, conflicts: [] });
    renderIndex('diario');
    expect(await screen.findByTestId('project-workspace')).toBeInTheDocument();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

    localStorage.setItem('obraplanner:ui-session', JSON.stringify({
      version: 1,
      projectId: 'project-1',
      view: 'dailyReport',
      mainScrollTop: 500,
      windowScrollY: 500,
      updatedAt: '2026-10-07T12:00:00.000Z',
    }));
    vi.mocked(window.scrollTo).mockClear();
    vi.mocked(Element.prototype.scrollTo).mockClear();
    const draft = screen.getByRole('textbox', { name: 'Rascunho da produção no teste' });
    fireEvent.change(draft, { target: { value: 'Texto ainda em edição' } });

    fireEvent.click(screen.getByRole('button', { name: 'Esvaziar diário' }));
    await waitFor(() => expect(mocks.saveOpenDailyReport).toHaveBeenCalled());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Rascunho da produção no teste' })).toBe(draft);
    expect(draft).toHaveValue('Texto ainda em edição');
  });

  it('repete uma falha transitória de autosave sem exigir nova edição', async () => {
    mocks.upsertCloudProject.mockRejectedValueOnce(new Error('Failed to fetch'));
    renderIndex();
    expect(await screen.findByTestId('project-workspace')).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar projeto' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).not.toHaveBeenCalledWith('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
  });

  it('não repete automaticamente um erro de permissão', async () => {
    mocks.upsertCloudProject.mockRejectedValueOnce({ code: '42501', message: 'permission denied' });
    renderIndex();
    expect(await screen.findByTestId('project-workspace')).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar projeto' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
  });

  it('repete uma sincronização parcial transitória após proteger o rascunho', async () => {
    mocks.upsertCloudProject
      .mockRejectedValueOnce(new CloudProjectPartialSyncError('cloud-v3', new Error('Failed to fetch')))
      .mockResolvedValueOnce('cloud-v4');
    renderIndex();
    expect(await screen.findByTestId('project-workspace')).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar projeto' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(1);
    expect(readStoredProjectDraft('project-1')).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(2);
    expect(readStoredProjectDraft('project-1')).toBeNull();
  });

  it('mantém o mesmo canal em tempo real ao trocar de área da mesma obra', async () => {
    renderIndex();
    expect(await screen.findByTestId('project-workspace')).toBeInTheDocument();
    expect(supabase.channel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Abrir Dashboard de teste' }));
    await waitFor(() => expect(screen.queryByTestId('project-workspace')).not.toBeInTheDocument());
    expect(supabase.channel).toHaveBeenCalledTimes(1);
    expect(supabase.removeChannel).not.toHaveBeenCalled();
  });

  it('não muda a hora da confirmação ao conferir uma obra sem alterações', async () => {
    mocks.getCloudProjectVersion.mockResolvedValue({
      id: 'project-1', updatedAt: 'cloud-v2', warehouseVersion: 1,
      warehouseUpdatedAt: 'cloud-v2',
    });
    renderIndex();
    expect(await screen.findByTestId('project-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-confirmed-at')).toHaveTextContent('cloud-v2');

    mocks.getCloudProjectVersion.mockClear();
    vi.useFakeTimers();
    fireEvent.focus(window);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    expect(mocks.getCloudProjectVersion).toHaveBeenCalled();
    expect(mocks.upsertCloudProject).not.toHaveBeenCalled();
    expect(screen.getByTestId('cloud-confirmed-at')).toHaveTextContent('cloud-v2');
  });

  it('pede confirmação antes de desmontar um formulário operacional não confirmado', async () => {
    renderIndex();
    expect(await screen.findByTestId('project-workspace')).toBeInTheDocument();
    const unregister = registerPendingForm('test-form', 'formulário de teste', () => true);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Abrir Dashboard de teste' }));
      expect(screen.getByText('Sair com formulário em preenchimento?')).toBeInTheDocument();
      expect(screen.getByTestId('project-workspace')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Continuar preenchendo' }));
      expect(screen.getByTestId('project-workspace')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Abrir Dashboard de teste' }));
      fireEvent.click(screen.getByRole('button', { name: 'Descartar e sair' }));
      await waitFor(() => expect(screen.queryByTestId('project-workspace')).not.toBeInTheDocument());
    } finally {
      unregister();
    }
  });

  it.each([
    ['producao', 'tasks', 'project-workspace', 'Rascunho da produção no teste'],
    ['almoxarifado', 'warehouse_movements', 'warehouse-workspace', 'Rascunho do Almoxarifado no teste'],
  ])('mantém %s montada durante uma atualização remota', async (routeView, table, workspaceId, draftLabel) => {
    const remoteRecord = deferred<ReturnType<typeof cloudRecord>>();
    let reads = 0;
    mocks.loadCloudProjectRecord.mockImplementation(async () => (
      ++reads === 1 ? cloudRecord(makeProject()) : remoteRecord.promise
    ));
    mocks.getCloudProjectVersion.mockResolvedValue({
      id: 'project-1', updatedAt: 'cloud-v3', warehouseVersion: 2,
      warehouseUpdatedAt: '2026-09-14T10:00:00.000Z',
    });

    renderIndex(routeView);
    expect(await screen.findByTestId(workspaceId)).toBeInTheDocument();
    const draft = screen.getByRole('textbox', { name: draftLabel });
    fireEvent.change(draft, { target: { value: 'Preenchimento em andamento' } });

    const realtime = mocks.realtimeHandlers.find(handler => handler.table === table);
    expect(realtime).toBeDefined();
    vi.useFakeTimers();
    act(() => realtime?.callback({ new: { id: 'remote-row', updated_at: 'cloud-v3' } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });

    expect(reads).toBe(2);
    expect(screen.getByTestId(workspaceId)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: draftLabel })).toBe(draft);
    expect(draft).toHaveValue('Preenchimento em andamento');

    await act(async () => {
      remoteRecord.resolve(cloudRecord(makeProject(), 'cloud-v3'));
      await Promise.resolve();
    });
    expect(screen.getByRole('textbox', { name: draftLabel })).toBe(draft);
    expect(draft).toHaveValue('Preenchimento em andamento');
    expect(reads).toBe(2);
  });

  it('recupera e confirma um rascunho local válido sem descartar a edição', async () => {
    const local = {
      ...makeProject(),
      name: 'Edição local recuperada',
      dailyReports: [{ ...report, observations: 'Diário local recuperado' }],
    };
    writeProjectDraft(local, 'cloud-v2', undefined, {
      loadedCollections: ['eapChapters', 'tasks', 'taskDailyLogs', 'dailyReports'],
    });

    renderIndex();
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Edição local recuperada');
    expect(readStoredProjectDraft(local.id)?.project.name).toBe('Edição local recuperada');
    expect(mocks.loadCloudProjectRecord.mock.calls[0]?.[1]?.collections).toEqual(expect.arrayContaining([
      'eapChapters',
      'tasks',
      'taskDailyLogs',
      'dailyReports',
    ]));

    fireEvent.click(screen.getByRole('button', { name: 'Trocar obra de teste' }));
    await waitFor(() => expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(1));

    expect(mocks.upsertCloudProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Edição local recuperada',
        dailyReports: [expect.objectContaining({ observations: 'Diário local recuperado' })],
      }),
      'org-1',
      'cloud-v2',
    );
    expect(readStoredProjectDraft(local.id)).toBeNull();
  });

  it('preserva como conflito um rascunho recuperável antigo sem escopo de coleções', async () => {
    const local = { ...makeProject(), name: 'Cópia local sem escopo' };
    writeProjectDraft(local, 'cloud-v2');

    renderIndex();

    expect(await screen.findByText('Conflito de cópia local')).toBeInTheDocument();
    expect(readStoredProjectDraft(local.id)?.project.name).toBe('Cópia local sem escopo');
    expect(mocks.upsertCloudProject).not.toHaveBeenCalled();
  });

  it('transforma draft cloud_changed não parcial em conflito explícito sem apagá-lo', async () => {
    const local = { ...makeProject(), name: 'Alteração local não confirmada' };
    writeProjectDraft(local, 'cloud-v1');

    renderIndex();

    expect(await screen.findByRole('alert', { name: '' })).toHaveTextContent('Conflito de cópia local');
    expect(readStoredProjectDraft(local.id)?.project.name).toBe('Alteração local não confirmada');
  });

  it('não troca de obra por flush enquanto um conflito de draft está ativo', async () => {
    const local = { ...makeProject(), name: 'Alteração local não confirmada' };
    writeProjectDraft(local, 'cloud-v1');
    renderIndex();
    await screen.findByText('Conflito de cópia local');

    fireEvent.click(screen.getByRole('button', { name: 'Trocar obra de teste' }));
    await act(async () => Promise.resolve());

    expect(mocks.loadCloudProjectRecord).toHaveBeenCalledTimes(1);
    expect(readStoredProjectDraft(local.id)?.project.name).toBe('Alteração local não confirmada');
  });

  it('bloqueia desfazer enquanto um conflito de draft está ativo', async () => {
    const local = { ...makeProject(), name: 'Alteração local não confirmada' };
    writeProjectDraft(local, 'cloud-v1');
    renderIndex();
    await screen.findByText('Conflito de cópia local');

    fireEvent.click(screen.getByRole('button', { name: 'Desfazer no teste' }));

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Resolva a divergência entre a cópia local e a nuvem antes de desfazer.',
    );
    expect(mocks.toastMessage).not.toHaveBeenCalledWith('Nada para desfazer');
    expect(readStoredProjectDraft(local.id)?.project.name).toBe('Alteração local não confirmada');
  });

  it('desfaz somente a operação local e mantém histórico posterior', async () => {
    renderIndex();
    await screen.findByTestId('project-workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Alterar projeto' }));
    expect(screen.getByTestId('project-name')).toHaveTextContent('Alteração geral pendente');
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer no teste' }));
    expect(screen.getByTestId('project-name')).toHaveTextContent(makeProject().name);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('remove do projeto parcial um Diário cuja exclusão já foi confirmada', async () => {
    const projectSave = deferred<string>();
    const dailySave = deferred<{ report: DailyReport | null; conflicts: string[] }>();
    mocks.upsertCloudProject.mockReturnValueOnce(projectSave.promise);
    mocks.saveOpenDailyReport.mockReturnValueOnce(dailySave.promise);

    renderIndex();
    expect(await screen.findByTestId('project-workspace')).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar projeto' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Esvaziar diário' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.saveOpenDailyReport).toHaveBeenCalledTimes(1);

    await act(async () => {
      projectSave.reject(new CloudProjectPartialSyncError('cloud-v3', new Error('collection failed')));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readStoredProjectDraft('project-1')?.pendingNormalizedSync).toBe(true);

    await act(async () => {
      dailySave.resolve({ report: null, conflicts: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    vi.useRealTimers();
    await waitFor(() => {
      const pending = readStoredProjectDraft('project-1');
      expect(pending?.pendingNormalizedSync).toBe(true);
      expect(pending?.project.dailyReports?.some(item => item.date === report.date)).toBe(false);
    });
    expect(localStorage.getItem(projectDraftKey('project-1'))).not.toBeNull();
  });

  it('libera a navegação após a confirmação do Almoxarifado, mesmo com o espelho legado do Diário pendente', async () => {
    const dailyConfirmation = deferred<{ report: DailyReport | null; conflicts: string[] }>();
    const confirmedProject = makeProject();
    mocks.saveOpenDailyReport.mockReturnValueOnce(dailyConfirmation.promise);
    mocks.commitWarehouseOperation.mockResolvedValueOnce({
      project: confirmedProject,
      committedAt: '2026-09-14T10:00:00.000Z',
      projectUpdatedAt: 'cloud-v3',
      warehouseUpdatedAt: '2026-09-14T10:00:00.000Z',
      warehouseVersion: 2,
      acknowledgement: {
        requisitionId: 'req-test',
        movementIds: [],
        auditLogIds: [],
      },
      dailyReportChanges: [{ date: report.date, before: report, after: report }],
    });

    renderIndex('almoxarifado');
    expect(await screen.findByTestId('warehouse-workspace')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar operação do almoxarifado' }));
    await waitFor(() => expect(mocks.commitWarehouseOperation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.saveOpenDailyReport).toHaveBeenCalledTimes(1));

    // A RPC já terminou; o espelho do Diário não pode prolongar a trava da
    // retirada nem impedir o trabalho em outra obra.
    fireEvent.click(screen.getByRole('button', { name: 'Trocar obra de teste' }));
    await waitFor(() => {
      expect(mocks.loadCloudProjectRecord.mock.calls.some(([id]) => id === 'project-2')).toBe(true);
    });

    await act(async () => {
      dailyConfirmation.resolve({ report, conflicts: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('rebaseia uma entrada remota do Almoxarifado ao salvar o Aditivo sem abrir conflito', async () => {
    const remoteWarehouseProject = {
      ...makeProject(),
      warehouse: {
        ...emptyWarehouse(),
        fiscalDuplicateReconciliationVersion: 1,
        movements: [{
          id: 'movimento-remoto',
          type: 'entrada',
          date: '2026-09-14',
          createdAt: '2026-09-14T10:00:00.000Z',
          itemKey: 'item-remoto',
          itemDescription: 'Material remoto',
          itemUnit: 'un',
          quantity: 1,
        }],
      },
    } as Project;
    let warehouseHasAdvanced = false;
    mocks.loadCloudProjectRecord.mockImplementation(async (id: string) => {
      if (id !== 'project-1') return cloudRecord(makeProject('project-2'));
      return warehouseHasAdvanced
        ? { ...cloudRecord(remoteWarehouseProject, 'cloud-v3'), warehouseVersion: 2 }
        : cloudRecord(makeProject());
    });
    mocks.getCloudProjectVersion.mockResolvedValue({
      id: 'project-1',
      updatedAt: 'cloud-v3',
      warehouseVersion: 2,
      warehouseUpdatedAt: '2026-09-14T10:00:00.000Z',
    });
    mocks.upsertCloudProject
      .mockImplementationOnce(async () => {
        warehouseHasAdvanced = true;
        throw new CloudProjectConflictError();
      })
      .mockResolvedValueOnce('cloud-v4');

    renderIndex('aditivo');
    expect(await screen.findByTestId('additive-workspace')).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar Aditivo local' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
    });

    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(2);
    expect(mocks.getCloudProjectVersion).toHaveBeenCalledWith('project-1');
    expect(mocks.loadCloudProjectRecord).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      collections: [
        'warehouseMovements',
        'warehouseRequisitions',
        'warehouseCustody',
        'stockMovements',
      ],
      strict: true,
      deferSnapshot: true,
    }));
    expect(mocks.upsertCloudProject.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      additives: [expect.objectContaining({ id: 'additive-local', name: 'Alteração local no Aditivo' })],
      warehouse: expect.objectContaining({ movements: [expect.objectContaining({ id: 'movimento-remoto', type: 'entrada', quantity: 1 })] }),
    }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rebaseia uma alteração remota do Diário ao salvar o Aditivo sem abrir conflito', async () => {
    const remoteDailyProject = {
      ...makeProject(),
      dailyReports: [{ ...report, observations: 'Atualização remota no Diário' }],
    };
    let dailyHasAdvanced = false;
    mocks.loadCloudProjectRecord.mockImplementation(async (id: string) => {
      if (id !== 'project-1') return cloudRecord(makeProject('project-2'));
      return dailyHasAdvanced
        ? cloudRecord(remoteDailyProject, 'cloud-v3')
        : cloudRecord(makeProject());
    });
    mocks.getCloudProjectVersion.mockResolvedValue({
      projectId: 'project-1',
      updatedAt: 'cloud-v3',
      warehouseVersion: 1,
      warehouseUpdatedAt: '2026-09-14T10:00:00.000Z',
    });
    mocks.upsertCloudProject
      .mockImplementationOnce(async () => {
        dailyHasAdvanced = true;
        throw new CloudProjectConflictError();
      })
      .mockResolvedValueOnce('cloud-v4');

    renderIndex('aditivo');
    expect(await screen.findByTestId('additive-workspace')).toBeInTheDocument();
    const dailyRealtime = mocks.realtimeHandlers.find(handler => handler.table === 'daily_reports');
    expect(dailyRealtime).toBeDefined();
    act(() => dailyRealtime?.callback({
      new: {
        id: 'daily-1',
        updated_at: 'cloud-v3',
        data: { ...remoteDailyProject.dailyReports[0] },
      },
    }));

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar Aditivo local' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
    });

    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(2);
    expect(mocks.loadCloudProjectRecord).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      collections: ['dailyReports'],
      strict: true,
      deferSnapshot: true,
    }));
    expect(mocks.upsertCloudProject.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      additives: [expect.objectContaining({ id: 'additive-local', name: 'Alteração local no Aditivo' })],
      dailyReports: [{ ...report, observations: 'Atualização remota no Diário' }],
    }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('mantém conflito explícito quando a mudança remota atinge o mesmo Aditivo em edição', async () => {
    mocks.upsertCloudProject.mockRejectedValueOnce(new CloudProjectConflictError());

    renderIndex('aditivo');
    expect(await screen.findByTestId('additive-workspace')).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar Aditivo local' }));
    const additiveRealtime = mocks.realtimeHandlers.find(handler => handler.table === 'additives');
    expect(additiveRealtime).toBeDefined();
    act(() => additiveRealtime?.callback({
      new: { id: 'additive-remote', updated_at: 'cloud-v3' },
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
    });

    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Conflito de cópia local')).toBeInTheDocument();
  });

  it('reconcilia registros diferentes no mesmo Aditivo sem perder a edição local', async () => {
    const remoteAdditive = {
      id: 'additive-remote',
      name: 'Criado em outro aparelho',
      importedAt: '2026-09-14T10:00:00.000Z',
      compositions: [],
    };
    const remoteProject = { ...makeProject(), additives: [remoteAdditive] } as Project;
    let remoteHasAdvanced = false;
    mocks.loadCloudProjectRecord.mockImplementation(async (id: string) => {
      if (id !== 'project-1') return cloudRecord(makeProject('project-2'));
      return remoteHasAdvanced ? cloudRecord(remoteProject, 'cloud-v3') : cloudRecord(makeProject());
    });
    mocks.getCloudProjectVersion.mockResolvedValue({
      projectId: 'project-1', updatedAt: 'cloud-v3', warehouseVersion: 1,
      warehouseUpdatedAt: '2026-09-14T10:00:00.000Z',
    });
    mocks.upsertCloudProject
      .mockImplementationOnce(async () => { remoteHasAdvanced = true; throw new CloudProjectConflictError(); })
      .mockResolvedValueOnce('cloud-v4');

    renderIndex('aditivo');
    expect(await screen.findByTestId('additive-workspace')).toBeInTheDocument();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar Aditivo local' }));
    const additiveRealtime = mocks.realtimeHandlers.find(handler => handler.table === 'additives');
    expect(additiveRealtime).toBeDefined();
    act(() => additiveRealtime?.callback({ new: { id: remoteAdditive.id, updated_at: 'cloud-v3' } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
    });

    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(2);
    expect(mocks.upsertCloudProject.mock.calls[1]?.[0].additives).toEqual([
      remoteAdditive,
      expect.objectContaining({ id: 'additive-local', name: 'Alteração local no Aditivo' }),
    ]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('mantém módulo e obra enquanto as fotos da retirada ainda estão sendo enviadas', async () => {
    const upload = deferred<void>();
    const confirmedProject = makeProject();
    mocks.warehouseUpload.mockReturnValueOnce(upload.promise);
    mocks.commitWarehouseOperation.mockResolvedValueOnce({
      project: confirmedProject,
      committedAt: '2026-09-14T10:00:00.000Z',
      projectUpdatedAt: 'cloud-v3',
      warehouseUpdatedAt: '2026-09-14T10:00:00.000Z',
      warehouseVersion: 2,
      acknowledgement: {
        requisitionId: 'req-photo-test',
        movementIds: [],
        auditLogIds: [],
      },
      dailyReportChanges: [],
    });

    renderIndex('almoxarifado');
    expect(await screen.findByTestId('warehouse-workspace')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar retirada com foto' }));
    await act(async () => Promise.resolve());
    expect(mocks.commitWarehouseOperation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir Dashboard de teste' }));
    expect(screen.getByTestId('warehouse-workspace')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Trocar obra de teste' }));
    await act(async () => Promise.resolve());
    expect(mocks.loadCloudProjectRecord.mock.calls.some(([id]) => id === 'project-2')).toBe(false);

    await act(async () => {
      upload.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.commitWarehouseOperation).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(mocks.loadCloudProjectRecord.mock.calls.some(([id]) => id === 'project-2')).toBe(true);
    });
  });

  it('não inicia upload se a troca de obra começou antes e ainda aguarda um salvamento', async () => {
    const projectSave = deferred<string>();
    mocks.upsertCloudProject.mockReturnValueOnce(projectSave.promise);

    renderIndex('almoxarifado');
    expect(await screen.findByTestId('warehouse-workspace')).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Alterar obra no almoxarifado' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(mocks.upsertCloudProject).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Trocar obra de teste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar retirada com foto' }));
    await act(async () => Promise.resolve());

    expect(mocks.warehouseUpload).not.toHaveBeenCalled();
    expect(mocks.commitWarehouseOperation).not.toHaveBeenCalled();
    expect(mocks.loadCloudProjectRecord.mock.calls.some(([id]) => id === 'project-2')).toBe(false);

    await act(async () => {
      projectSave.resolve('cloud-v3');
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(mocks.loadCloudProjectRecord.mock.calls.some(([id]) => id === 'project-2')).toBe(true);
    });
  });

  it('não abre Usuários enquanto uma retirada com foto está pendente', async () => {
    const upload = deferred<void>();
    mocks.warehouseUpload.mockReturnValueOnce(upload.promise);
    mocks.commitWarehouseOperation.mockResolvedValueOnce({
      project: makeProject(),
      committedAt: '2026-09-14T10:00:00.000Z',
      projectUpdatedAt: 'cloud-v3',
      warehouseUpdatedAt: '2026-09-14T10:00:00.000Z',
      warehouseVersion: 2,
      acknowledgement: {
        requisitionId: 'req-photo-test',
        movementIds: [],
        auditLogIds: [],
      },
      dailyReportChanges: [],
    });

    renderIndex('almoxarifado');
    expect(await screen.findByTestId('warehouse-workspace')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar retirada com foto' }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Abrir usuários de teste' }));

    expect(screen.getByTestId('warehouse-workspace')).toBeInTheDocument();
    expect(mocks.commitWarehouseOperation).not.toHaveBeenCalled();

    await act(async () => {
      upload.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.commitWarehouseOperation).toHaveBeenCalledTimes(1));
  });

  it('intercepta o retorno do navegador durante o upload da retirada', async () => {
    const upload = deferred<void>();
    mocks.warehouseUpload.mockReturnValueOnce(upload.promise);
    mocks.commitWarehouseOperation.mockResolvedValueOnce({
      project: makeProject(),
      committedAt: '2026-09-14T10:00:00.000Z',
      projectUpdatedAt: 'cloud-v3',
      warehouseUpdatedAt: '2026-09-14T10:00:00.000Z',
      warehouseVersion: 2,
      acknowledgement: {
        requisitionId: 'req-photo-test',
        movementIds: [],
        auditLogIds: [],
      },
      dailyReportChanges: [],
    });

    renderIndex('almoxarifado');
    expect(await screen.findByTestId('warehouse-workspace')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar retirada com foto' }));
    await act(async () => Promise.resolve());

    act(() => window.dispatchEvent(new PopStateEvent('popstate')));

    expect(screen.getByTestId('warehouse-workspace')).toBeInTheDocument();
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'Aguarde a confirmação da operação do Almoxarifado na nuvem.',
    );
    expect(mocks.commitWarehouseOperation).not.toHaveBeenCalled();

    await act(async () => {
      upload.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.commitWarehouseOperation).toHaveBeenCalledTimes(1));
  });
});
