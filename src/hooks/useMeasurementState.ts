import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContractInfo, Project, SavedMeasurement } from '@/types/project';
import { isoAddDays, suggestPeriodForNext, getProjectStartDate } from '@/components/measurement/measurementFormat';

export interface UseMeasurementStateParams {
  project: Project;
  onProjectChange: (project: Project) => void;
}

/**
 * Centraliza estados, setters e efeitos de formulário/rascunho da tela de Medição.
 *
 * IMPORTANTE: NÃO altera nenhum cálculo (rows, totals, snapshot, exportação).
 * Apenas move o que antes estava inline em Measurement.tsx para um hook reutilizável.
 */
export function useMeasurementState({ project, onProjectChange }: UseMeasurementStateParams) {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // Mantém referência sempre atualizada do projeto, para evitar que callbacks/effects
  // usem versões obsoletas após múltiplas chamadas a onProjectChange no mesmo tick.
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  const measurements = useMemo<SavedMeasurement[]>(
    () => (project.measurements || []).slice().sort((a, b) => a.number - b.number),
    [project.measurements],
  );

  const contract: ContractInfo = project.contractInfo || {};

  const getMeasurementActiveStorageKey = (projectId: string) =>
    `obraplanner-measurement-active-${projectId}`;
  const activeIdStorageKey = getMeasurementActiveStorageKey(project.id);

  // Inicializa otimisticamente com o valor salvo (sem validar contra measurements ainda),
  // pois no primeiro render a lista pode estar vazia/desatualizada.
  const [activeId, setActiveIdState] = useState<string>(() => {
    try {
      return localStorage.getItem(activeIdStorageKey) || 'live';
    } catch {
      return 'live';
    }
  });
  const setActiveId = (id: string) => {
    setActiveIdState(id);
    try { localStorage.setItem(activeIdStorageKey, id); } catch {}
  };

  // Reconciliação: roda quando troca de projeto OU quando a lista de medições muda.
  // Só volta para 'live' se a lista já carregou e o id salvo realmente não existe.
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(getMeasurementActiveStorageKey(project.id)); } catch {}
    const list = project.measurements || [];

    if (!saved || saved === 'live') {
      setActiveIdState('live');
      return;
    }
    if (list.some(m => m.id === saved)) {
      setActiveIdState(saved);
      return;
    }
    // Lista ainda não carregou — preserva escolha salva, não força 'live'.
    if (list.length === 0) {
      setActiveIdState(saved);
      return;
    }
    // Lista carregada e id salvo não existe mais → volta para 'live'.
    setActiveIdState('live');
    try { localStorage.setItem(getMeasurementActiveStorageKey(project.id), 'live'); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.measurements]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Número da próxima medição em preparação (default)
  const defaultNextNumber =
    (contract.nextMeasurementNumber ??
      ((measurements[measurements.length - 1]?.number || 0) + 1)) || 1;

  // Rascunho persistido para a medição em preparação
  const initialDraft = project.measurementDraft;
  const initialDraftMatches = !!(initialDraft && initialDraft.number === defaultNextNumber);

  // Período sugerido (caso não exista rascunho válido) — usa início da obra do Gantt como base.
  const initialSuggested = suggestPeriodForNext(measurements, today, monthAgo, getProjectStartDate(project));

  // Form de filtros
  const [startDate, setStartDate] = useState(
    initialDraftMatches && initialDraft?.startDate ? initialDraft.startDate : initialSuggested.startDate,
  );
  const [endDate, setEndDate] = useState(
    initialDraftMatches && initialDraft?.endDate ? initialDraft.endDate : initialSuggested.endDate,
  );
  const [chapterFilter, setChapterFilter] = useState<string>(
    initialDraftMatches && initialDraft?.chapterFilter ? initialDraft.chapterFilter : 'all',
  );
  const [search, setSearch] = useState(
    initialDraftMatches && initialDraft?.search ? initialDraft.search : '',
  );
  // Estado visual de capítulos colapsados, persistido por activeId no projeto.
  const initialCollapsed = useMemo(() => {
    const map = project.measurementUiState?.collapsedByActiveId || {};
    return new Set<string>(map['live'] || []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [collapsed, setCollapsedState] = useState<Set<string>>(initialCollapsed);

  // Cabeçalho (formulário contratual)
  const [contractor, setContractor] = useState(contract.contractor || '');
  const [contracted, setContracted] = useState(contract.contracted || '');
  const [contractNumber, setContractNumber] = useState(contract.contractNumber || '');
  const [contractObject, setContractObject] = useState(contract.contractObject || '');
  const [location, setLocation] = useState(contract.location || '');
  const [budgetSource, setBudgetSource] = useState(contract.budgetSource || '');
  const [artNumber, setArtNumber] = useState(contract.artNumber || '');
  const [bdiInput, setBdiInput] = useState(
    contract.bdiPercent !== undefined ? String(contract.bdiPercent) : '25',
  );
  const [measurementNumber, setMeasurementNumber] = useState(String(defaultNextNumber));
  const issueDate = today;

  // Diálogos
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [confirmEdit, setConfirmEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editReason, setEditReason] = useState('');
  const [editingPriceTaskId, setEditingPriceTaskId] = useState<string | null>(null);
  const [editingPriceValue, setEditingPriceValue] = useState<string>('');

  // Recarrega cabeçalho + rascunho ao trocar de obra
  useEffect(() => {
    const c = project.contractInfo || {};
    setContractor(c.contractor || '');
    setContracted(c.contracted || '');
    setContractNumber(c.contractNumber || '');
    setContractObject(c.contractObject || '');
    setLocation(c.location || '');
    setBudgetSource(c.budgetSource || '');
    setArtNumber(c.artNumber || '');
    setBdiInput(c.bdiPercent !== undefined ? String(c.bdiPercent) : '25');

    const sortedMs = (project.measurements || []).slice().sort((a, b) => a.number - b.number);
    const nextNum =
      (c.nextMeasurementNumber ?? ((sortedMs[sortedMs.length - 1]?.number || 0) + 1)) || 1;
    setMeasurementNumber(String(nextNum));
    const d = project.measurementDraft;
    if (d && d.number === nextNum && d.startDate && d.endDate) {
      setStartDate(d.startDate);
      setEndDate(d.endDate);
      setChapterFilter(d.chapterFilter || 'all');
      setSearch(d.search || '');
    } else {
      const s = suggestPeriodForNext(sortedMs, today, monthAgo, getProjectStartDate(project));
      setStartDate(s.startDate);
      setEndDate(s.endDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Sincroniza nº sugerido conforme a quantidade de medições muda
  useEffect(() => {
    if (activeId !== 'live') return;
    const next = (measurements[measurements.length - 1]?.number || 0) + 1;
    setMeasurementNumber(prev => (prev === String(next) ? prev : String(next || 1)));
    const d = project.measurementDraft;
    if (d && d.number === next && d.startDate && d.endDate) {
      setStartDate(d.startDate);
      setEndDate(d.endDate);
    } else {
      const s = suggestPeriodForNext(measurements, today, monthAgo, getProjectStartDate(project));
      setStartDate(s.startDate);
      setEndDate(s.endDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measurements.length, activeId]);

  // Autocorreção: Data final < Data inicial → ajusta para início + 30 dias
  useEffect(() => {
    if (activeId !== 'live') return;
    if (startDate && endDate && endDate < startDate) {
      setEndDate(isoAddDays(startDate, 29));
    }
  }, [activeId, startDate, endDate]);

  // Recarrega capítulos colapsados ao trocar entre live/snapshots ou ao trocar de obra.
  useEffect(() => {
    const map = projectRef.current.measurementUiState?.collapsedByActiveId || {};
    setCollapsedState(new Set<string>(map[activeId] || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, project.id]);

  // Wrapper que atualiza estado local e persiste a lista por activeId no projeto.
  const setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>> = (action) => {
    setCollapsedState(prev => {
      const next = typeof action === 'function'
        ? (action as (p: Set<string>) => Set<string>)(prev)
        : action;
      const latestProject = projectRef.current;
      const map = { ...(latestProject.measurementUiState?.collapsedByActiveId || {}) };
      const arr = Array.from(next);
      const cur = map[activeId] || [];
      const sameLen = cur.length === arr.length;
      const same = sameLen && cur.every(id => next.has(id));
      if (!same) {
        if (arr.length === 0) delete map[activeId]; else map[activeId] = arr;
        onProjectChange({
          ...latestProject,
          measurementUiState: {
            ...(latestProject.measurementUiState || {}),
            collapsedByActiveId: map,
          },
        });
      }
      return next;
    });
  };

  // Persiste rascunho (datas + filtros) por nº de medição em preparação.
  useEffect(() => {
    if (activeId !== 'live') return;
    const num = Number(measurementNumber);
    if (!Number.isFinite(num) || num <= 0) return;
    const latestProject = projectRef.current;
    const current = latestProject.measurementDraft;
    const nextDraft = {
      number: num,
      startDate,
      endDate,
      chapterFilter,
      search,
    };
    if (
      current &&
      current.number === nextDraft.number &&
      current.startDate === nextDraft.startDate &&
      current.endDate === nextDraft.endDate &&
      (current.chapterFilter || 'all') === nextDraft.chapterFilter &&
      (current.search || '') === nextDraft.search
    ) {
      return;
    }
    onProjectChange({ ...latestProject, measurementDraft: nextDraft });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, measurementNumber, startDate, endDate, chapterFilter, search]);

  return {
    // refs/derivados
    projectRef,
    measurements,
    contract,
    today,
    monthAgo,
    defaultNextNumber,
    issueDate,
    // seleção
    activeId, setActiveId,
    historyOpen, setHistoryOpen,
    // filtros
    startDate, setStartDate,
    endDate, setEndDate,
    chapterFilter, setChapterFilter,
    search, setSearch,
    collapsed, setCollapsed,
    // cabeçalho contratual
    contractor, setContractor,
    contracted, setContracted,
    contractNumber, setContractNumber,
    contractObject, setContractObject,
    location, setLocation,
    budgetSource, setBudgetSource,
    artNumber, setArtNumber,
    bdiInput, setBdiInput,
    measurementNumber, setMeasurementNumber,
    // diálogos
    confirmGenerate, setConfirmGenerate,
    confirmEdit, setConfirmEdit,
    confirmDelete, setConfirmDelete,
    editReason, setEditReason,
    editingPriceTaskId, setEditingPriceTaskId,
    editingPriceValue, setEditingPriceValue,
  };
}
