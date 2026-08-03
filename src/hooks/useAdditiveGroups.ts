import { useMemo } from 'react';
import type { Project, Additive as AdditiveModel, AdditiveComposition } from '@/types/project';
import { getChapterTree, getChapterNumbering, type ChapterNode } from '@/lib/chapters';
import { computeAdditiveRow, resolveAdditivePricingRule } from '@/lib/additiveImport';
import type { CompGroup } from '@/components/additive/types';

export function useAdditiveGroups(
  project: Project,
  active: AdditiveModel | null,
  search: string,
  bankFilter: string,
) {
  const banks = useMemo(() => {
    if (!active) return [] as string[];
    const set = new Set<string>();
    active.compositions.forEach(c => { if (c.bank) set.add(c.bank); });
    return Array.from(set).sort();
  }, [active]);

  const filteredComps = useMemo(() => {
    if (!active) return [] as AdditiveComposition[];
    const term = search.trim().toLowerCase();
    return active.compositions.filter(c => {
      if (bankFilter !== 'all' && c.bank !== bankFilter) return false;
      if (term) {
        const hay = `${c.item} ${c.code} ${c.description}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [active, search, bankFilter]);

  const globalDiscount = active?.globalDiscountPercent ?? 0;
  const bdi = active?.bdiPercent ?? 0;

  const { groupTree, orphanRows, hasEapLink } = useMemo(() => {
    const empty = { groupTree: [] as CompGroup[], orphanRows: [] as AdditiveComposition[], hasEapLink: false };
    if (!active) return empty;
    void globalDiscount;
    const pricingRule = resolveAdditivePricingRule(active);
    const compsByPhase = new Map<string, AdditiveComposition[]>();
    const visiblePhaseIds = new Set(active.visiblePhaseIds ?? []);
    const orphans: AdditiveComposition[] = [];
    let anyLinked = false;
    filteredComps.forEach(c => {
      if (c.phaseId) {
        anyLinked = true;
        const arr = compsByPhase.get(c.phaseId) || [];
        arr.push(c);
        compsByPhase.set(c.phaseId, arr);
      } else {
        orphans.push(c);
      }
    });
    if (!anyLinked && visiblePhaseIds.size === 0) return { ...empty, orphanRows: filteredComps };

    const numbering = getChapterNumbering(project);
    const tree = getChapterTree(project);

    const buildNode = (chapterNode: ChapterNode, depth: number): CompGroup | null => {
      const directRows = [...(compsByPhase.get(chapterNode.phase.id) || [])]
        .sort((a, b) => (a.itemNumber || a.item || '').localeCompare(
          b.itemNumber || b.item || '',
          'pt-BR',
          { numeric: true },
        ));
      const childGroups = chapterNode.children
        .map(c => buildNode(c, depth + 1))
        .filter((g): g is CompGroup => g !== null);
      const isExplicitlyVisible = visiblePhaseIds.has(chapterNode.phase.id);
      if (directRows.length === 0 && childGroups.length === 0 && !isExplicitlyVisible) return null;

      let subtotalTotalFonte = 0;
      let subtotalContratado = 0;
      let subtotalSuprimido = 0;
      let subtotalAcrescido = 0;
      let subtotalFinal = 0;
      directRows.forEach(c => {
        const r = computeAdditiveRow(c, bdi, globalDiscount, pricingRule);
        subtotalTotalFonte += r.totalFonte;
        subtotalContratado += r.valorContratadoOriginalPreservado;
        subtotalSuprimido += r.valorSuprimido;
        subtotalAcrescido += r.valorAcrescido;
        subtotalFinal += r.valorFinal;
      });
      childGroups.forEach(c => {
        subtotalTotalFonte += c.subtotalTotalFonte;
        subtotalContratado += c.subtotalContratado;
        subtotalSuprimido += c.subtotalSuprimido;
        subtotalAcrescido += c.subtotalAcrescido;
        subtotalFinal += c.subtotalFinal;
      });
      return {
        phaseId: chapterNode.phase.id,
        number: numbering.get(chapterNode.phase.id) || '',
        name: chapterNode.phase.name,
        depth,
        rows: directRows,
        children: childGroups,
        subtotalTotalFonte,
        subtotalContratado,
        subtotalSuprimido,
        subtotalAcrescido,
        subtotalFinal,
        subtotalDiferenca: subtotalFinal - subtotalContratado,
      };
    };

    const groups = tree
      .map(n => buildNode(n, 0))
      .filter((g): g is CompGroup => g !== null)
      .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));

    return { groupTree: groups, orphanRows: orphans, hasEapLink: anyLinked || groups.length > 0 };
  }, [active, filteredComps, project, globalDiscount, bdi]);

  return { banks, filteredComps, groupTree, orphanRows, hasEapLink };
}
