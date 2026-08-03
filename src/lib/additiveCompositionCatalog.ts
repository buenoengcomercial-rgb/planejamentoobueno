import type {
  AdditiveComposition,
  AdditiveCompositionTemplate,
  AdditiveInput,
} from '@/types/project';

export function normalizeAdditiveCatalogCode(value?: string | null): string {
  return (value ?? '').trim().toUpperCase().replace(/[\s._]+/g, '');
}

export function normalizeAdditiveCatalogBank(value?: string | null): string {
  return (value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

const cloneInputs = (inputs: AdditiveInput[] = []): AdditiveInput[] =>
  inputs.map(input => ({ ...input }));

function templateKey(code: string): string {
  return normalizeAdditiveCatalogCode(code);
}

function hasPositiveReferencePrice(template: Pick<AdditiveCompositionTemplate,
  'unitPriceNoBDIInformed' | 'analyticReferenceUnitPriceNoBDI'>): boolean {
  return [template.unitPriceNoBDIInformed, template.analyticReferenceUnitPriceNoBDI]
    .some(value => Number.isFinite(value) && Number(value) > 0);
}

export function isCompleteAdditiveCompositionTemplate(template: AdditiveCompositionTemplate): boolean {
  const description = normalizedDescription(template.description);
  return !!normalizeAdditiveCatalogCode(template.code)
    && !!normalizeAdditiveCatalogBank(template.bank)
    && !!description
    && description !== 'NOVO SERVICO'
    && !!(template.unit ?? '').trim()
    && (hasPositiveReferencePrice(template) || (template.inputs ?? []).length > 0);
}

function templateTimestamp(template: AdditiveCompositionTemplate): number {
  const timestamp = Date.parse(template.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function selectMostRecentCompleteTemplate(
  candidates: AdditiveCompositionTemplate[],
): AdditiveCompositionTemplate | undefined {
  return candidates.reduce<AdditiveCompositionTemplate | undefined>((selected, candidate) => {
    if (!isCompleteAdditiveCompositionTemplate(candidate)) return selected;
    if (!selected || templateTimestamp(candidate) >= templateTimestamp(selected)) return candidate;
    return selected;
  }, undefined);
}

export interface ConsolidateAdditiveCompositionCatalogResult {
  catalog: AdditiveCompositionTemplate[];
  changed: boolean;
  consolidatedCodes: string[];
}

/** Consolida o legado para uma unica estrutura completa e mais recente por codigo. */
export function consolidateAdditiveCompositionCatalog(
  catalog: AdditiveCompositionTemplate[] = [],
): ConsolidateAdditiveCompositionCatalogResult {
  const grouped = new Map<string, AdditiveCompositionTemplate[]>();
  const codeOrder: string[] = [];
  for (const candidate of catalog) {
    const key = templateKey(candidate.code || candidate.normalizedCode);
    if (!key) continue;
    if (!grouped.has(key)) codeOrder.push(key);
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const consolidatedCodes: string[] = [];
  const canonical = codeOrder.flatMap(code => {
    const candidates = grouped.get(code) ?? [];
    const selected = selectMostRecentCompleteTemplate(candidates);
    if (!selected) {
      if (candidates.length > 0) consolidatedCodes.push(code);
      return [];
    }
    const normalized: AdditiveCompositionTemplate = {
      ...selected,
      id: `additive-template:${code}`,
      normalizedCode: code,
      inputs: cloneInputs(selected.inputs),
    };
    if (candidates.length !== 1
      || selected.id !== normalized.id
      || selected.normalizedCode !== normalized.normalizedCode) {
      consolidatedCodes.push(code);
    }
    return [normalized];
  });

  const changed = JSON.stringify(canonical) !== JSON.stringify(catalog);
  return { catalog: changed ? canonical : catalog, changed, consolidatedCodes };
}

export function compositionTemplateFrom(
  composition: AdditiveComposition,
  sourceAdditiveId?: string,
  now = new Date().toISOString(),
): AdditiveCompositionTemplate | null {
  const normalizedCode = normalizeAdditiveCatalogCode(composition.code);
  if (!normalizedCode || !normalizeAdditiveCatalogBank(composition.bank)) return null;
  const bank = composition.bank ?? '';
  return {
    id: `additive-template:${templateKey(composition.code)}`,
    code: composition.code,
    normalizedCode,
    bank,
    description: composition.description ?? '',
    unit: composition.unit ?? '',
    unitPriceNoBDIInformed: composition.unitPriceNoBDIInformed ?? composition.unitPriceNoBDI,
    analyticReferenceUnitPriceNoBDI: composition.analyticReferenceUnitPriceNoBDI,
    inputs: cloneInputs(composition.inputs ?? []),
    sourceAdditiveId,
    updatedAt: now,
  };
}

export function upsertAdditiveCompositionTemplate(
  catalog: AdditiveCompositionTemplate[] = [],
  composition: AdditiveComposition,
  sourceAdditiveId?: string,
  now?: string,
): AdditiveCompositionTemplate[] {
  if (!composition.isNewService) return catalog;
  const template = compositionTemplateFrom(composition, sourceAdditiveId, now);
  const consolidated = consolidateAdditiveCompositionCatalog(catalog).catalog;
  if (!template || !isCompleteAdditiveCompositionTemplate(template)) return consolidated;
  return consolidateAdditiveCompositionCatalog([...consolidated, template]).catalog;
}

export interface CompositionTemplateResolution {
  template?: AdditiveCompositionTemplate;
}

export function resolveAdditiveCompositionTemplate(
  catalog: AdditiveCompositionTemplate[] = [],
  activeCompositions: AdditiveComposition[] = [],
  targetId: string,
  code: string,
): CompositionTemplateResolution {
  const normalizedCode = normalizeAdditiveCatalogCode(code);
  if (!normalizedCode) return {};

  const catalogCandidates = catalog.filter(candidate =>
    (candidate.normalizedCode || normalizeAdditiveCatalogCode(candidate.code)) === normalizedCode,
  );
  const catalogTemplate = selectMostRecentCompleteTemplate(catalogCandidates);
  if (catalogTemplate) return { template: catalogTemplate };

  const survivingCandidates: AdditiveCompositionTemplate[] = [];
  activeCompositions.forEach((composition, index) => {
    if (composition.id === targetId || !composition.isNewService) return;
    if (normalizeAdditiveCatalogCode(composition.code) !== normalizedCode) return;
    // A ordem recebida e da ocorrencia mais antiga para a mais recente.
    const fallbackTimestamp = new Date(index + 1).toISOString();
    const template = compositionTemplateFrom(composition, undefined, fallbackTimestamp);
    if (template) survivingCandidates.push(template);
  });
  return { template: selectMostRecentCompleteTemplate(survivingCandidates) };
}

export function cloneTemplateTechnicalPatch(
  template: AdditiveCompositionTemplate,
  makeInputId: () => string,
): Partial<AdditiveComposition> {
  return {
    bank: template.bank,
    description: template.description,
    unit: template.unit,
    unitPriceNoBDIInformed: template.unitPriceNoBDIInformed,
    analyticReferenceUnitPriceNoBDI: template.analyticReferenceUnitPriceNoBDI,
    inputs: template.inputs.map(input => ({ ...input, id: makeInputId() })),
  };
}

function normalizedDescription(value?: string | null): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

/**
 * Linha criada manualmente que recebeu apenas o código, mas ainda conserva
 * integralmente a estrutura técnica padrão do botão "Novo serviço".
 */
export function isIncompleteNewService(composition: AdditiveComposition): boolean {
  const hasReferencePrice = [
    composition.unitPriceNoBDIInformed,
    composition.analyticReferenceUnitPriceNoBDI,
    composition.unitPriceNoBDI,
  ].some(value => Number.isFinite(value) && Number(value) > 0);
  const description = normalizedDescription(composition.description);
  return !!composition.isNewService
    && !!normalizeAdditiveCatalogCode(composition.code)
    && !normalizeAdditiveCatalogBank(composition.bank)
    && (description === '' || description === 'NOVO SERVICO')
    && (composition.inputs ?? []).length === 0
    && !hasReferencePrice;
}

export interface RestoreIncompleteResult {
  compositions: AdditiveComposition[];
  restored: Array<{ compositionId: string; code: string; sourceTemplateId: string }>;
}

/** Restaura somente linhas totalmente vazias; preenchimentos parciais permanecem intocados. */
export function restoreIncompleteNewServices(
  catalog: AdditiveCompositionTemplate[] = [],
  compositions: AdditiveComposition[] = [],
  candidates: AdditiveComposition[] = compositions,
  makeInputId: () => string,
): RestoreIncompleteResult {
  const restored: RestoreIncompleteResult['restored'] = [];
  const next = compositions.map(composition => {
    if (!isIncompleteNewService(composition)) return composition;
    const resolution = resolveAdditiveCompositionTemplate(
      catalog, candidates, composition.id, composition.code,
    );
    if (!resolution.template) return composition;
    restored.push({
      compositionId: composition.id,
      code: composition.code,
      sourceTemplateId: resolution.template.id,
    });
    return {
      ...composition,
      ...cloneTemplateTechnicalPatch(resolution.template, makeInputId),
    };
  });
  return { compositions: restored.length > 0 ? next : compositions, restored };
}

const itemNumberOf = (composition: AdditiveComposition) => composition.itemNumber || composition.item || '';

function itemSuffix(composition: AdditiveComposition, prefix: string): number {
  const number = itemNumberOf(composition);
  if (!number.startsWith(`${prefix}.`)) return Number.MAX_SAFE_INTEGER;
  const suffix = Number(number.slice(prefix.length + 1).split('.')[0]);
  return Number.isInteger(suffix) && suffix > 0 ? suffix : Number.MAX_SAFE_INTEGER;
}

function stablePhaseRows(compositions: AdditiveComposition[], phaseId: string, prefix: string) {
  return compositions
    .map((composition, index) => ({ composition, index }))
    .filter(entry => entry.composition.phaseId === phaseId)
    .sort((left, right) => itemSuffix(left.composition, prefix) - itemSuffix(right.composition, prefix) || left.index - right.index);
}

function availableSuffixes(phaseRows: ReturnType<typeof stablePhaseRows>, count: number, prefix: string): number[] {
  const contracted = new Set(phaseRows
    .filter(entry => !entry.composition.isNewService)
    .map(entry => itemSuffix(entry.composition, prefix))
    .filter(Number.isFinite));
  const available: number[] = [];
  for (let suffix = 1; available.length < count; suffix += 1) {
    if (!contracted.has(suffix)) available.push(suffix);
  }
  return available;
}

export type ReorderNewServiceResult =
  | { ok: true; compositions: AdditiveComposition[]; before: string; after: string }
  | { ok: false; error: string };

export function reorderNewService(
  compositions: AdditiveComposition[],
  compositionId: string,
  requestedItem: string,
): ReorderNewServiceResult {
  const target = compositions.find(composition => composition.id === compositionId);
  if (!target?.isNewService || !target.phaseId) return { ok: false, error: 'Somente novos serviços vinculados podem ser reordenados.' };
  const current = itemNumberOf(target);
  const parts = current.split('.');
  if (parts.length < 2) return { ok: false, error: 'A hierarquia atual do serviço é inválida.' };
  const prefix = parts.slice(0, -1).join('.');
  const raw = requestedItem.trim();
  const requestedFull = /^\d+$/.test(raw) ? `${prefix}.${raw}` : raw;
  if (!requestedFull.startsWith(`${prefix}.`)) return { ok: false, error: `O serviço deve permanecer no subcapítulo ${prefix}.` };
  const requestedSuffixText = requestedFull.slice(prefix.length + 1);
  if (!/^\d+$/.test(requestedSuffixText)) return { ok: false, error: 'Informe uma posição inteira válida.' };
  const requestedSuffix = Number(requestedSuffixText);
  if (!Number.isInteger(requestedSuffix) || requestedSuffix <= 0) return { ok: false, error: 'A posição deve ser maior que zero.' };

  const phaseRows = stablePhaseRows(compositions, target.phaseId, prefix);
  const newRows = phaseRows.filter(entry => entry.composition.isNewService);
  const available = availableSuffixes(phaseRows, newRows.length, prefix);
  const requestedRank = available.indexOf(requestedSuffix);
  const contractedConflict = phaseRows.some(entry => !entry.composition.isNewService && itemSuffix(entry.composition, prefix) === requestedSuffix);
  if (contractedConflict) return { ok: false, error: 'A posição informada pertence a um item contratado e não pode ser alterada.' };
  if (requestedRank < 0) return { ok: false, error: `A última posição disponível neste subcapítulo é ${available[available.length - 1] ?? 0}.` };

  const currentIndex = newRows.findIndex(entry => entry.composition.id === compositionId);
  if (currentIndex < 0) return { ok: false, error: 'Serviço não encontrado no subcapítulo.' };
  const ordered = [...newRows];
  const [moving] = ordered.splice(currentIndex, 1);
  ordered.splice(requestedRank, 0, moving);
  const numberById = new Map(ordered.map((entry, index) => [entry.composition.id, `${prefix}.${available[index]}`]));
  const phaseSlots = compositions.map((composition, index) => ({ composition, index }))
    .filter(entry => entry.composition.phaseId === target.phaseId && entry.composition.isNewService)
    .map(entry => entry.index);
  const updatedByRank = ordered.map(entry => {
    const itemNumber = numberById.get(entry.composition.id)!;
    return { ...entry.composition, item: itemNumber, itemNumber };
  });
  const next = [...compositions];
  phaseSlots.forEach((slot, index) => { next[slot] = updatedByRank[index]; });
  return { ok: true, compositions: next, before: current, after: `${prefix}.${requestedSuffix}` };
}

export function removeNewServiceAndCompact(
  compositions: AdditiveComposition[],
  compositionId: string,
): AdditiveComposition[] {
  const target = compositions.find(composition => composition.id === compositionId);
  const remaining = compositions.filter(composition => composition.id !== compositionId);
  if (!target?.isNewService || !target.phaseId) return remaining;
  const current = itemNumberOf(target);
  const prefix = current.split('.').slice(0, -1).join('.');
  if (!prefix) return remaining;
  const phaseRows = stablePhaseRows(remaining, target.phaseId, prefix);
  const rows = phaseRows.filter(entry => entry.composition.isNewService);
  const available = availableSuffixes(phaseRows, rows.length, prefix);
  const numberById = new Map(rows.map((entry, index) => [entry.composition.id, `${prefix}.${available[index]}`]));
  return remaining.map(composition => {
    const itemNumber = numberById.get(composition.id);
    return itemNumber ? { ...composition, item: itemNumber, itemNumber } : composition;
  });
}
