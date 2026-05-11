import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  hasAdditiveUserWork,
  isAdditiveReplacementBlocked,
  mergeAdditiveWithSynthetic,
} from '@/lib/additiveUserWork';
import type {
  Project, Additive as AdditiveModel, AdditiveComposition,
  AdditiveStatus, AdditiveApprovalSnapshot,
} from '@/types/project';
import {
  importAdditiveFromExcel, exportAdditiveToExcel, exportAdditiveToPdf,
  additiveTotals, getApprovedAdditiveBudgetItems,
  buildAdditiveFromSyntheticBudgetItems,
  createNewServiceComposition, contractAdditive,
} from '@/lib/additiveImport';
import { trunc2 } from '@/lib/financialEngine';
import {
  exportAdditiveSyntheticCompletePro,
  exportAdditiveNewServicesPro,
  exportAdditiveCalculationMemoryPro,
  exportAdditiveSyntheticCompletePdf,
  exportAdditiveNewServicesPdf,
  exportAdditiveCalculationMemoryPdf,
} from '@/lib/additiveReports';
import { useAuth } from '@/hooks/useAuth';
import { logToProject, userInfoFromSupabaseUser } from '@/lib/audit';
import type { AdditiveStateApi } from '@/hooks/useAdditiveState';

interface Params {
  project: Project;
  onProjectChange: (next: Project | ((prev: Project) => Project)) => void;
  state: AdditiveStateApi;
}

export function useAdditiveActions({ project, onProjectChange, state }: Params) {
  const { user } = useAuth();
  const auditUser = useMemo(() => userInfoFromSupabaseUser(user), [user]);
  const {
    active, isLocked,
    setActiveId,
    importName, setImportDialogOpen, setImportName,
    pendingFile, setPendingFile, fileRef,
    setIssuesOpen,
    reviewNotes, setReviewNotes, approvedBy, setApprovedBy,
    setReviewDialogOpen, setConfirmDeleteId, activeId,
  } = state;

  const logAdd = (
    additiveId: string,
    params: Omit<Parameters<typeof logToProject>[1], 'entityType' | 'entityId'>,
  ) => {
    onProjectChange(prev => logToProject(prev, {
      ...params,
      ...auditUser,
      entityType: 'additive',
      entityId: additiveId,
    }));
  };

  const updateAdditive = useCallback((mutator: (a: AdditiveModel) => AdditiveModel) => {
    if (!active) return;
    const id = active.id;
    onProjectChange(prev => ({
      ...prev,
      additives: (prev.additives ?? []).map(a => a.id === id ? mutator(a) : a),
    }));
  }, [active, onProjectChange]);

  const updateComposition = useCallback((compId: string, patch: Partial<AdditiveComposition>) => {
    const normCode = (s: string) => String(s ?? '').trim().toLowerCase();
    const normInputCode = (s: string) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    const money2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
    const genId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `inp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    let autofillLog: { code: string; sourceId: string; sourceDesc: string; targetId: string; targetChain?: string } | null = null;
    const priceSyncLogs: Array<{
      code: string; previousPrice: number; newPrice: number;
      occurrences: number; affectedCompositions: Array<{ id: string; item?: string; description: string }>;
    }> = [];

    updateAdditive(a => {
      const target = a.compositions.find(c => c.id === compId);
      if (!target) return a;

      let effectivePatch: Partial<AdditiveComposition> = { ...patch };

      // Autofill por código: somente em novos serviços, quando o código for alterado
      // e existir outra nova composição aditivada com o mesmo código (case/space-insensitive).
      const codeChanged = Object.prototype.hasOwnProperty.call(patch, 'code');
      const isNew = !!target.isNewService;
      if (codeChanged && isNew) {
        const newCode = normCode(patch.code ?? '');
        if (newCode) {
          const source = a.compositions.find(c =>
            c.id !== compId &&
            !!c.isNewService &&
            normCode(c.code) === newCode,
          );
          if (source) {
            const clonedInputs = (source.inputs ?? []).map(i => ({ ...i, id: genId() }));
            effectivePatch = {
              ...effectivePatch,
              bank: source.bank,
              description: source.description,
              unit: source.unit,
              unitPriceNoBDIInformed: source.unitPriceNoBDIInformed,
              unitPriceNoBDI: source.unitPriceNoBDI,
              unitPriceWithBDI: source.unitPriceWithBDI,
              analyticUnitPriceWithBDI: source.analyticUnitPriceWithBDI,
              inputs: clonedInputs,
              calculationMemoryColumns: source.calculationMemoryColumns
                ? { ...source.calculationMemoryColumns }
                : target.calculationMemoryColumns,
            };
            autofillLog = {
              code: source.code,
              sourceId: source.id,
              sourceDesc: source.description,
              targetId: target.id,
              targetChain: target.phaseChain,
            };
          }
        }
      }

      // Sincronização de preço de insumos: somente em novos serviços, quando inputs foram alterados.
      // Detecta insumos cujo unitPrice mudou e propaga para todos insumos com mesmo código
      // em outras novas composições aditivadas.
      type PriceChange = { code: string; prev: number; next: number };
      const priceChanges: PriceChange[] = [];
      if (isNew && Array.isArray(effectivePatch.inputs)) {
        const prevById = new Map(target.inputs.map(i => [i.id, i]));
        for (const ni of effectivePatch.inputs) {
          const prev = prevById.get(ni.id);
          if (!prev) continue;
          const code = normInputCode(ni.code);
          if (!code) continue;
          if (money2(prev.unitPrice) !== money2(ni.unitPrice)) {
            priceChanges.push({ code, prev: prev.unitPrice, next: ni.unitPrice });
          }
        }
      }

      const updatedCompositions = a.compositions.map(c =>
        c.id === compId ? { ...c, ...effectivePatch } : c,
      );

      let finalCompositions = updatedCompositions;
      if (priceChanges.length > 0) {
        // Última alteração por código vence (caso usuário edite múltiplas linhas no mesmo commit)
        const byCode = new Map<string, PriceChange>();
        for (const ch of priceChanges) byCode.set(ch.code, ch);

        finalCompositions = updatedCompositions.map(c => {
          if (c.id === compId) return c;
          if (!c.isNewService) return c;
          let mutated = false;
          const newInputs = c.inputs.map(i => {
            const code = normInputCode(i.code);
            if (!code) return i;
            const ch = byCode.get(code);
            if (!ch) return i;
            if (money2(i.unitPrice) === money2(ch.next)) return i;
            mutated = true;
            const unitPrice = ch.next;
            return { ...i, unitPrice, total: money2((i.coefficient || 0) * unitPrice) };
          });
          return mutated ? { ...c, inputs: newInputs } : c;
        });

        // Coleta logs/toasts (uma entrada por código alterado)
        for (const ch of byCode.values()) {
          const affected = finalCompositions
            .filter(c => c.id !== compId && c.isNewService &&
              c.inputs.some(i => normInputCode(i.code) === ch.code))
            .map(c => ({ id: c.id, item: c.item || c.itemNumber, description: c.description }));
          priceSyncLogs.push({
            code: ch.code,
            previousPrice: ch.prev,
            newPrice: ch.next,
            occurrences: affected.length,
            affectedCompositions: affected,
          });
        }
      }

      return { ...a, compositions: finalCompositions };
    });

    if (autofillLog && active) {
      logAdd(active.id, {
        action: 'updated',
        title: 'Composição aditivada preenchida automaticamente por código',
        metadata: autofillLog,
      });
    }
    if (priceSyncLogs.length > 0 && active) {
      for (const ps of priceSyncLogs) {
        if (ps.occurrences > 0) {
          toast.success(`Preço do insumo ${ps.code} atualizado em ${ps.occurrences} ocorrência(s) de novas composições.`);
        } else {
          toast.success('Preço do insumo atualizado.');
        }
        logAdd(active.id, {
          action: 'updated',
          title: 'Preço de insumo sincronizado nas novas composições',
          metadata: ps,
        });
      }
    }
  }, [updateAdditive, active]);

  const updateCompositionQuantity = useCallback((
    compId: string,
    field: 'addedQuantity' | 'suppressedQuantity',
    nextValue: number,
  ) => {
    if (!active) return;
    const comp = active.compositions.find(c => c.id === compId);
    if (!comp) return;
    const before = comp[field] ?? 0;
    if (before === nextValue) return;
    updateComposition(compId, { [field]: nextValue });
    logAdd(active.id, {
      action: 'updated',
      title: field === 'addedQuantity'
        ? 'Quantidade acrescida alterada'
        : 'Quantidade suprimida alterada',
      metadata: {
        item: comp.item || comp.itemNumber,
        code: comp.code,
        description: comp.description,
        before,
        after: nextValue,
      },
      before,
      after: nextValue,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, updateComposition]);

  const handleFileSelected = (f: File | null) => {
    if (!f) return;
    setPendingFile(f);
    const base = f.name.replace(/\.(xlsx|xls)$/i, '');
    setImportName(base || 'Aditivo');
    setImportDialogOpen(true);
  };

  const handleConfirmImport = async () => {
    if (!pendingFile) return;
    try {
      const XLSX = await import('xlsx');
      const buf = await pendingFile.arrayBuffer();
      const peek = XLSX.read(buf, { type: 'array' });
      const normName = (n: string) => n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const lower = peek.SheetNames.map(normName);
      let hasSynth = lower.some(n => n.includes('sintetica'));
      let hasAnaly = lower.some(n => n.includes('analitica'));

      if (!hasAnaly) {
        for (let i = 0; i < peek.SheetNames.length; i++) {
          const name = peek.SheetNames[i];
          if (hasSynth && normName(name).includes('sintetica')) continue;
          const ws = peek.Sheets[name];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as unknown[][];
          const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
          for (let r = 0; r < Math.min(rows.length, 30); r++) {
            const cells = (rows[r] || []).map(norm);
            const joined = cells.join(' | ');
            const hits = [
              cells.some(c => c === 'item' || c.startsWith('item')),
              joined.includes('codigo'),
              cells.some(c => c === 'banco' || c.startsWith('banco')),
              joined.includes('descricao'),
              cells.some(c => c === 'quant' || c.startsWith('quant') || c === 'coef' || c.startsWith('coef')),
              cells.some(c => c === 'un' || c === 'und' || c === 'unid' || c.startsWith('unid')),
            ].filter(Boolean).length;
            if (hits >= 4) { hasAnaly = true; break; }
          }
          if (hasAnaly) break;
        }
      }

      const draftCandidate = active && (active.status ?? 'rascunho') === 'rascunho' && !active.isContracted ? active : null;

      if (!hasSynth && !hasAnaly) {
        toast.error('Nenhuma aba reconhecida (esperado SINTETICA e/ou ANALITICA, ou planilha com cabeçalhos compatíveis).');
        return;
      }

      if (!hasSynth && hasAnaly && !draftCandidate) {
        toast.error('Importe ou selecione um aditivo em rascunho antes de vincular a Analítica.');
        return;
      }

      toast.loading('Importando aditivo...', { id: 'imp-add' });
      const result = await importAdditiveFromExcel(
        pendingFile,
        importName.trim() || 'Aditivo',
        draftCandidate,
      );

      const hasFatalError = (result.additive.issues ?? []).some(
        i => i.level === 'error' && /nenhuma aba reconhecida/i.test(i.message),
      );
      if (hasFatalError && result.additive.compositions.length === 0) {
        toast.error('Nenhuma aba reconhecida na planilha. Nada foi adicionado.', { id: 'imp-add' });
        return;
      }

      const inputsCount = result.additive.compositions.reduce((a, c) => a + (c.inputs?.length ?? 0), 0);
      const importMeta = {
        fileName: pendingFile.name,
        mode: result.mode,
        hasSynthetic: hasSynth,
        hasAnalytic: hasAnaly,
        compositionsCount: result.additive.compositions.length,
        inputsCount,
      };

      if (result.mode === 'analytic_only' && draftCandidate) {
        const merged = result.additive;
        onProjectChange(prev => {
          const next = {
            ...prev,
            additives: (prev.additives ?? []).map(a =>
              a.id === draftCandidate.id
                ? { ...merged, id: draftCandidate.id, name: draftCandidate.name, status: draftCandidate.status ?? 'rascunho' }
                : a,
            ),
          };
          return logToProject(next, {
            ...auditUser,
            entityType: 'additive',
            entityId: draftCandidate.id,
            action: 'imported',
            title: 'Planilha importada no Aditivo',
            metadata: importMeta,
          });
        });
        setActiveId(draftCandidate.id);
      } else {
        onProjectChange(prev => {
          const next = {
            ...prev,
            additives: [...(prev.additives ?? []), result.additive],
          };
          return logToProject(next, {
            ...auditUser,
            entityType: 'additive',
            entityId: result.additive.id,
            action: 'imported',
            title: 'Planilha importada no Aditivo',
            metadata: importMeta,
          });
        });
        setActiveId(result.additive.id);
      }

      const errCount = result.additive.issues?.filter(i => i.level === 'error').length ?? 0;
      const warnCount = result.additive.issues?.filter(i => i.level === 'warning').length ?? 0;
      toast.success(
        `${result.message}${errCount ? ` (${errCount} erros)` : ''}${warnCount ? ` (${warnCount} avisos)` : ''}`,
        { id: 'imp-add' },
      );
      if (errCount + warnCount > 0) setIssuesOpen(true);
    } catch (e) {
      console.error(e);
      toast.error('Falha ao importar a planilha do aditivo.', { id: 'imp-add' });
    } finally {
      setImportDialogOpen(false);
      setPendingFile(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleExportExcel = async () => {
    if (!active) return;
    try {
      await exportAdditiveToExcel(active);
      toast.success('Excel gerado');
      logAdd(active.id, { action: 'exported', title: 'Aditivo exportado em Excel' });
    } catch { toast.error('Falha ao gerar Excel'); }
  };

  const handleExportSyntheticCompleteExcel = async () => {
    if (!active) return;
    try {
      await exportAdditiveSyntheticCompletePro(project, active);
      toast.success('Sintética Completa exportada');
      logAdd(active.id, { action: 'exported', title: 'Sintética Completa exportada em Excel' });
    } catch (e) { console.error(e); toast.error('Falha ao gerar Sintética Completa'); }
  };

  const handleExportNewServicesExcel = async () => {
    if (!active) return;
    try {
      await exportAdditiveNewServicesPro(project, active);
      toast.success('Novas Composições exportadas');
      logAdd(active.id, { action: 'exported', title: 'Novas Composições exportadas em Excel' });
    } catch (e) { console.error(e); toast.error('Falha ao gerar Novas Composições'); }
  };

  const handleExportCalculationMemoryExcel = async () => {
    if (!active) return;
    try {
      await exportAdditiveCalculationMemoryPro(project, active);
      toast.success('Memória de Cálculo exportada');
      logAdd(active.id, { action: 'exported', title: 'Memória de Cálculo exportada em Excel' });
    } catch (e) { console.error(e); toast.error('Falha ao gerar Memória de Cálculo'); }
  };

  const handleExportPdf = async (showAnalytic: boolean) => {
    if (!active) return;
    try {
      await exportAdditiveToPdf(active, project, showAnalytic);
      toast.success('PDF gerado');
      logAdd(active.id, { action: 'exported', title: 'Aditivo exportado em PDF' });
    } catch (e) {
      console.error('Erro ao gerar PDF do aditivo', e);
      toast.error('Falha ao gerar PDF do aditivo. Verifique o console para detalhes.');
    }
  };

  const handleExportSyntheticCompletePdf = async () => {
    if (!active) return;
    try {
      await exportAdditiveSyntheticCompletePdf(project, active);
      toast.success('Sintética Completa (PDF) gerada');
      logAdd(active.id, { action: 'exported', title: 'Sintética Completa exportada em PDF' });
    } catch (e) { console.error(e); toast.error('Falha ao gerar PDF da Sintética Completa'); }
  };

  const handleExportNewServicesPdf = async () => {
    if (!active) return;
    try {
      await exportAdditiveNewServicesPdf(project, active);
      toast.success('Novas Composições (PDF) gerada');
      logAdd(active.id, { action: 'exported', title: 'Novas Composições exportadas em PDF' });
    } catch (e) { console.error(e); toast.error('Falha ao gerar PDF das Novas Composições'); }
  };

  const handleExportCalculationMemoryPdf = async () => {
    if (!active) return;
    try {
      await exportAdditiveCalculationMemoryPdf(project, active);
      toast.success('Memória de Cálculo (PDF) gerada');
      logAdd(active.id, { action: 'exported', title: 'Memória de Cálculo exportada em PDF' });
    } catch (e) { console.error(e); toast.error('Falha ao gerar PDF da Memória de Cálculo'); }
  };


  const handleDeleteAdditive = (id: string) => {
    const target = (project.additives ?? []).find(a => a.id === id);
    onProjectChange(prev => {
      const next = {
        ...prev,
        additives: (prev.additives ?? []).filter(a => a.id !== id),
      };
      return logToProject(next, {
        ...auditUser,
        entityType: 'additive',
        entityId: id,
        action: 'deleted',
        title: 'Aditivo excluído',
        description: target?.name,
      });
    });
    if (activeId === id) {
      const remaining = (project.additives ?? []).filter(a => a.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
    setConfirmDeleteId(null);
    toast.success('Aditivo excluído');
  };

  const handleChangeBdi = (value: string) => {
    if (!active || isLocked) return;
    const num = Number(value.replace(',', '.'));
    if (!Number.isFinite(num) || num < 0) return;
    const before = active.bdiPercent ?? 0;
    if (before === num) return;
    updateAdditive(a => ({ ...a, bdiPercent: num }));
    logAdd(active.id, {
      action: 'updated',
      title: 'BDI do aditivo alterado',
      before,
      after: num,
    });
  };

  const setStatus = (next: AdditiveStatus, extra?: Partial<AdditiveModel>) => {
    updateAdditive(a => ({ ...a, status: next, ...(extra ?? {}) }));
  };

  const handleSendForReview = () => {
    if (!active) return;
    setStatus('em_analise');
    const t = additiveTotals(active, project);
    const errCount = (active.issues ?? []).filter(i => i.level === 'error').length;
    const warnCount = (active.issues ?? []).filter(i => i.level === 'warning').length;
    logAdd(active.id, {
      action: 'submitted_for_review',
      title: 'Aditivo enviado para análise fiscal',
      metadata: {
        totalContratadoOriginal: t.totalContratadoOriginal,
        totalSuprimido: t.totalSuprimido,
        totalAcrescido: t.totalAcrescido,
        valorFinal: t.valorFinal,
        diferencaLiquida: t.diferencaLiquida,
        percentImpactoLiquido: t.percentImpactoLiquido,
        errorsCount: errCount,
        warningsCount: warnCount,
      },
    });
    toast.success('Aditivo enviado para análise fiscal');
  };

  const handleReject = () => {
    if (!active) return;
    setStatus('reprovado', { reviewNotes: reviewNotes || undefined });
    logAdd(active.id, {
      action: 'rejected',
      title: 'Aditivo reprovado',
      description: reviewNotes || undefined,
    });
    toast.success('Aditivo reprovado — voltou para ajuste');
    setReviewDialogOpen(false);
    setReviewNotes('');
  };

  const handleApprove = () => {
    if (!active) return;
    const totals = additiveTotals(active, project);
    const nextVersion = (active.version ?? 0) + 1;
    const approvedAt = new Date().toISOString();
    const snapshot: AdditiveApprovalSnapshot = {
      version: nextVersion,
      approvedAt,
      approvedBy: approvedBy || undefined,
      reviewNotes: reviewNotes || undefined,
      bdiPercent: active.bdiPercent ?? 0,
      globalDiscountPercent: active.globalDiscountPercent ?? 0,
      totals,
      compositions: JSON.parse(JSON.stringify(active.compositions)),
      issues: JSON.parse(JSON.stringify(active.issues ?? [])),
    };
    const approvedAdditive: AdditiveModel = {
      ...active,
      status: 'aprovado',
      approvedAt,
      approvedBy: approvedBy || undefined,
      reviewNotes: reviewNotes || undefined,
      version: nextVersion,
      approvalSnapshots: [...(active.approvalSnapshots ?? []), snapshot],
    };
    onProjectChange(prev => {
      const nextAdditives = (prev.additives ?? []).map(a =>
        a.id === active.id ? approvedAdditive : a,
      );
      const projWithApproved: Project = { ...prev, additives: nextAdditives };
      const approvedBudget = getApprovedAdditiveBudgetItems(projWithApproved);
      const keep = (prev.budgetItems ?? []).filter(b => b.source !== 'aditivo');
      const next = {
        ...projWithApproved,
        budgetItems: [...keep, ...approvedBudget],
      };
      return logToProject(next, {
        ...auditUser,
        entityType: 'additive',
        entityId: active.id,
        action: 'approved',
        title: 'Aditivo aprovado',
        description: approvedBy ? `Por ${approvedBy}` : undefined,
        metadata: {
          version: nextVersion,
          totalContratadoOriginal: totals.totalContratadoOriginal,
          totalSuprimido: totals.totalSuprimido,
          totalAcrescido: totals.totalAcrescido,
          valorFinal: totals.valorFinal,
          percentImpactoLiquido: totals.percentImpactoLiquido,
        },
      });
    });
    toast.success('Aditivo aprovado e integrado à Medição');
    setReviewDialogOpen(false);
    setApprovedBy('');
    setReviewNotes('');
  };

  const handleBackToDraft = () => {
    if (!active) return;
    onProjectChange(prev => {
      const nextAdditives = (prev.additives ?? []).map(a =>
        a.id === active.id ? { ...a, status: 'rascunho' as AdditiveStatus } : a,
      );
      const projWithChange: Project = { ...prev, additives: nextAdditives };
      const approvedBudget = getApprovedAdditiveBudgetItems(projWithChange);
      const keep = (prev.budgetItems ?? []).filter(b => b.source !== 'aditivo');
      const next = { ...projWithChange, budgetItems: [...keep, ...approvedBudget] };
      return logToProject(next, {
        ...auditUser,
        entityType: 'additive',
        entityId: active.id,
        action: 'unlocked',
        title: 'Aditivo voltou para rascunho',
      });
    });
    toast.success('Aditivo voltou para rascunho — itens removidos da Medição');
  };

  const [syntheticConflictOpen, setSyntheticConflictOpen] = useState(false);

  const performCreateNewFromSynthetic = useCallback(() => {
    const built = buildAdditiveFromSyntheticBudgetItems(project, 'Aditivo (a partir da Sintética da Medição)');
    if (!built) {
      toast.error('Nenhuma Sintética encontrada na Medição. Importe a Sintética primeiro na aba Tarefas/EAP.');
      return;
    }
    onProjectChange(prev => {
      const next = { ...prev, additives: [...(prev.additives ?? []), built] };
      return logToProject(next, {
        ...auditUser,
        entityType: 'additive',
        entityId: built.id,
        action: 'imported',
        title: 'Aditivo criado a partir da Sintética da Medição',
        metadata: {
          compositionsCount: built.compositions.length,
          source: 'sintetica_medicao',
        },
      });
    });
    setActiveId(built.id);
    toast.success(`Sintética da Medição reaproveitada (${built.compositions.length} composições).`);
  }, [project, onProjectChange, auditUser, setActiveId]);

  const performMergePreservingSynthetic = useCallback(() => {
    if (!active) return;
    const built = buildAdditiveFromSyntheticBudgetItems(project, active.name);
    if (!built) {
      toast.error('Nenhuma Sintética encontrada na Medição.');
      return;
    }
    const { merged, stats } = mergeAdditiveWithSynthetic(active, built);
    const id = active.id;
    onProjectChange(prev => {
      const next = {
        ...prev,
        additives: (prev.additives ?? []).map(a => a.id === id ? merged : a),
      };
      return logToProject(next, {
        ...auditUser,
        entityType: 'additive',
        entityId: id,
        action: 'updated',
        title: 'Sintética da Medição reaplicada (preservando alterações)',
        metadata: { ...stats, source: 'sintetica_medicao_merge' },
      });
    });
    toast.success(
      `Sintética reaplicada: ${stats.refreshedFromSynthetic} atualizadas, ${stats.addedFromSynthetic} novas, ${stats.preservedNewServices} novos serviços preservados.`,
    );
  }, [active, project, onProjectChange, auditUser]);

  const handleUseSyntheticFromMeasurement = () => {
    // Sem aditivo ativo ou sem trabalho → cria direto
    if (!active || !hasAdditiveUserWork(active)) {
      performCreateNewFromSynthetic();
      return;
    }
    // Aditivo com edições → abre diálogo de proteção
    setSyntheticConflictOpen(true);
  };

  const syntheticConflict = {
    open: syntheticConflictOpen,
    setOpen: setSyntheticConflictOpen,
    blocked: isAdditiveReplacementBlocked(active),
    onCancel: () => setSyntheticConflictOpen(false),
    onCreateNew: () => {
      setSyntheticConflictOpen(false);
      performCreateNewFromSynthetic();
    },
    onMergePreserving: () => {
      setSyntheticConflictOpen(false);
      performMergePreservingSynthetic();
    },
  };

  const handleChangeGlobalDiscount = (value: string) => {
    if (!active || isLocked) return;
    const num = Number(value.replace(',', '.'));
    if (!Number.isFinite(num) || num < 0) return;
    const before = active.globalDiscountPercent ?? 0;
    if (before === num) return;
    updateAdditive(a => ({ ...a, globalDiscountPercent: num }));
    logAdd(active.id, {
      action: 'updated',
      title: 'Desconto licitatório do aditivo alterado',
      before,
      after: num,
    });
  };

  const handleAddNewService = (phaseId: string, phaseChain: string, parentNumber: string) => {
    if (!active || isLocked) return;
    const novo = createNewServiceComposition(active, phaseId, phaseChain, parentNumber);
    updateAdditive(a => ({ ...a, compositions: [...a.compositions, novo] }));
    logAdd(active.id, {
      action: 'created',
      title: 'Novo serviço criado no aditivo',
      metadata: {
        item: novo.itemNumber,
        code: novo.code,
        phaseId,
        phaseChain,
      },
    });
    toast.success(`Novo serviço ${novo.itemNumber} adicionado`);
  };

  const handleRemoveComposition = (compId: string) => {
    if (!active || isLocked) return;
    const comp = active.compositions.find(c => c.id === compId);
    updateAdditive(a => ({ ...a, compositions: a.compositions.filter(c => c.id !== compId) }));
    if (comp?.isNewService) {
      logAdd(active.id, {
        action: 'deleted',
        title: 'Novo serviço excluído do aditivo',
        metadata: {
          item: comp.item || comp.itemNumber,
          code: comp.code,
          description: comp.description,
          inputsCount: (comp.inputs ?? []).length,
          memoryRowsCount: (comp.calculationMemory ?? []).length,
        },
      });
    }
  };

  const handleContractAdditive = () => {
    if (!active) return;
    if (active.status !== 'aprovado' && !active.isContracted) {
      toast.error('O aditivo precisa estar Aprovado para ser contratado.');
      return;
    }
    const novosServicos = active.compositions.filter(c => c.isNewService);
    onProjectChange(prev => {
      const next = contractAdditive(prev, active.id);
      return logToProject(next, {
        ...auditUser,
        entityType: 'additive',
        entityId: active.id,
        action: 'contracted',
        title: 'Aditivo contratado e integrado ao projeto',
        metadata: {
          novosServicosIntegrados: novosServicos.length,
          budgetItemsCriados: (next.budgetItems ?? []).filter(b => b.additiveId === active.id).length,
        },
      });
    });
    toast.success('Aditivo contratado — novos serviços integrados ao projeto');
  };

  // ----- Memória de cálculo -----
  const setCalculationMemory = (
    compId: string,
    rows: import('@/types/project').AdditiveCalculationMemoryRow[],
  ) => {
    if (!active || isLocked) return;
    const comp = active.compositions.find(c => c.id === compId);
    if (!comp) return;
    const beforeAdded = comp.addedQuantity ?? 0;
    const beforeSuppressed = comp.suppressedQuantity ?? 0;
    const totalsAdded = rows
      .filter(r => r.type !== 'suprimida')
      .reduce((acc, r) => trunc2(acc + trunc2(Number.isFinite(r.partial) ? r.partial : 0)), 0);
    const totalsSuppressed = rows
      .filter(r => r.type === 'suprimida')
      .reduce((acc, r) => trunc2(acc + trunc2(Number.isFinite(r.partial) ? r.partial : 0)), 0);
    const patch: Partial<import('@/types/project').AdditiveComposition> = {
      calculationMemory: rows,
    };
    if (rows.length > 0) {
      patch.addedQuantity = totalsAdded;
      patch.suppressedQuantity = totalsSuppressed;
    } else {
      // Memória esvaziada: zera quantidades calculadas pela memória.
      patch.addedQuantity = 0;
      patch.suppressedQuantity = 0;
    }
    updateComposition(compId, patch);
    const impactAdded = rows.length > 0 && totalsAdded !== beforeAdded;
    const impactSuppressed = rows.length > 0 && totalsSuppressed !== beforeSuppressed;
    if (impactAdded || impactSuppressed || rows.length === 0) {
      logAdd(active.id, {
        action: 'updated',
        title: 'Memória de cálculo alterada',
        metadata: {
          item: comp.item || comp.itemNumber,
          code: comp.code,
          description: comp.description,
          rows: rows.length,
          totalAcrescido: totalsAdded,
          totalSuprimido: totalsSuppressed,
          impactedAcrescido: impactAdded,
          impactedSuprimido: impactSuppressed,
        },
      });
    }
  };

  return {
    updateAdditive,
    updateComposition,
    updateCompositionQuantity,
    setCalculationMemory,
    handleFileSelected,
    handleConfirmImport,
    handleExportExcel,
    handleExportSyntheticCompleteExcel,
    handleExportNewServicesExcel,
    handleExportCalculationMemoryExcel,
    handleExportPdf,
    handleExportSyntheticCompletePdf,
    handleExportNewServicesPdf,
    handleExportCalculationMemoryPdf,
    handleDeleteAdditive,
    handleChangeBdi,
    handleSendForReview,
    handleReject,
    handleApprove,
    handleBackToDraft,
    handleUseSyntheticFromMeasurement,
    handleChangeGlobalDiscount,
    handleAddNewService,
    handleRemoveComposition,
    handleContractAdditive,
    syntheticConflict,
  };
}

export type AdditiveActionsApi = ReturnType<typeof useAdditiveActions>;
