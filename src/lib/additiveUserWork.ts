import type { Additive, AdditiveComposition } from '@/types/project';
import { validMemoryRows } from '@/lib/calculationMemory';

/**
 * Detecta se o aditivo possui qualquer trabalho/edição manual feita pelo usuário
 * que possa ser perdida ao re-importar a Sintética da Medição.
 */
export function hasAdditiveUserWork(add: Additive | null | undefined): boolean {
  if (!add) return false;

  // Status diferente de rascunho = trabalho relevante
  const status = add.status ?? 'rascunho';
  if (status !== 'rascunho') return true;
  if (add.isContracted) return true;
  if ((add.approvalSnapshots?.length ?? 0) > 0) return true;

  // BDI ou desconto licitatório alterado
  if ((add.globalDiscountPercent ?? 0) > 0) return true;

  for (const c of add.compositions ?? []) {
    if (c.isNewService) return true;
    if ((c.inputs?.length ?? 0) > 0) return true;
    if (validMemoryRows(c.calculationMemory).length > 0) return true;
    if ((c.addedQuantity ?? 0) > 0) return true;
    if ((c.suppressedQuantity ?? 0) > 0) return true;
    if (c.changeKind && c.changeKind !== 'sem_alteracao') return true;
  }
  return false;
}

/** Aditivo está bloqueado para substituição direta (apenas criar novo). */
export function isAdditiveReplacementBlocked(add: Additive | null | undefined): boolean {
  if (!add) return false;
  if (add.editUnlocked) return false;
  const status = add.status ?? 'rascunho';
  if (add.isContracted) return true;
  return status === 'em_analise' || status === 'aprovado' || status === 'aditivo_contratado';
}

export interface MergeSyntheticResult {
  merged: Additive;
  stats: {
    syntheticCount: number;
    addedFromSynthetic: number;
    refreshedFromSynthetic: number;
    preservedNewServices: number;
    preservedWithMemory: number;
    preservedWithInputs: number;
  };
}

/**
 * Atualiza um aditivo existente com a Sintética recém-construída,
 * preservando todo trabalho manual do usuário:
 *  - novos serviços (isNewService) intactos
 *  - inputs manuais preservados
 *  - calculationMemory / calculationMemoryColumns
 *  - addedQuantity / suppressedQuantity / changeKind
 *  - bdi / desconto / uiState / status
 *
 * Para composições vindas da Sintética (não-novos serviços), atualiza:
 *  - description / code / bank / unit / item / itemNumber / phaseId / phaseChain / taskId
 *  - quantity / unitPriceNoBDI / unitPriceWithBDI / total / totalNoBDI / totalWithBDI
 * mantendo os IDs originais para não quebrar referências de UI.
 */
export function mergeAdditiveWithSynthetic(
  current: Additive,
  fresh: Additive,
): MergeSyntheticResult {
  const matchKey = (c: AdditiveComposition) => {
    if (c.taskId) return `task:${c.taskId}`;
    if (c.itemNumber) return `item:${c.itemNumber.trim().toUpperCase()}`;
    const code = (c.code || '').trim().toUpperCase();
    const desc = (c.description || '').trim().toUpperCase();
    if (code) return `code:${code}|${desc}`;
    return `desc:${desc}`;
  };

  const freshByKey = new Map<string, AdditiveComposition>();
  fresh.compositions.forEach(fc => {
    const k = matchKey(fc);
    if (!freshByKey.has(k)) freshByKey.set(k, fc);
  });

  let refreshed = 0;
  let preservedNew = 0;
  let preservedMemory = 0;
  let preservedInputs = 0;

  const consumed = new Set<string>();

  const updatedExisting: AdditiveComposition[] = current.compositions.map(cur => {
    if (cur.isNewService) {
      preservedNew++;
      return cur;
    }
    const k = matchKey(cur);
    const fc = freshByKey.get(k);
    if (!fc) return cur; // sem correspondência → mantém como está
    consumed.add(k);
    refreshed++;
    if ((cur.inputs?.length ?? 0) > 0) preservedInputs++;
    if (validMemoryRows(cur.calculationMemory).length > 0) preservedMemory++;
    return {
      ...cur,
      // Atualiza dados vindos da Sintética
      item: fc.item || cur.item,
      code: fc.code || cur.code,
      bank: fc.bank || cur.bank,
      description: fc.description || cur.description,
      unit: fc.unit || cur.unit,
      quantity: fc.quantity,
      unitPriceNoBDI: fc.unitPriceNoBDI,
      unitPriceWithBDI: fc.unitPriceWithBDI,
      total: fc.total,
      totalNoBDI: fc.totalNoBDI,
      totalWithBDI: fc.totalWithBDI,
      source: fc.source ?? cur.source,
      phaseId: fc.phaseId ?? cur.phaseId,
      phaseChain: fc.phaseChain ?? cur.phaseChain,
      taskId: fc.taskId ?? cur.taskId,
      itemNumber: fc.itemNumber ?? cur.itemNumber,
      // originalQuantity passa a refletir a Sintética atualizada
      originalQuantity: fc.quantity,
      // Preserva: inputs, calculationMemory, calculationMemoryColumns,
      // addedQuantity, suppressedQuantity, changeKind, isNewService=false,
      // unitPriceNoBDIInformed
    };
  });

  // Adiciona composições novas da Sintética que ainda não existiam
  const additions: AdditiveComposition[] = [];
  fresh.compositions.forEach(fc => {
    const k = matchKey(fc);
    if (!consumed.has(k)) {
      additions.push(fc);
    }
  });

  const merged: Additive = {
    ...current,
    // Mantém id, name, status, bdi, desconto, uiState, snapshots, version
    compositions: [...updatedExisting, ...additions],
    importedAt: new Date().toISOString(),
    issues: [
      ...(current.issues ?? []),
      {
        level: 'info',
        message: `Sintética da Medição reaplicada preservando alterações manuais (atualizadas: ${refreshed}, novas: ${additions.length}, novos serviços preservados: ${preservedNew}).`,
      },
    ],
  };

  return {
    merged,
    stats: {
      syntheticCount: fresh.compositions.length,
      addedFromSynthetic: additions.length,
      refreshedFromSynthetic: refreshed,
      preservedNewServices: preservedNew,
      preservedWithMemory: preservedMemory,
      preservedWithInputs: preservedInputs,
    },
  };
}
