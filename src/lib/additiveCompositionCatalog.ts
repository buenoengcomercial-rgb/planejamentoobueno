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

function templateKey(code: string, bank: string): string {
  return `${normalizeAdditiveCatalogCode(code)}|${normalizeAdditiveCatalogBank(bank)}`;
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
    id: `additive-template:${templateKey(composition.code, bank)}`,
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
  if (!template) return catalog;
  const key = templateKey(template.code, template.bank);
  const existingIndex = catalog.findIndex(candidate => templateKey(candidate.code, candidate.bank) === key);
  if (existingIndex < 0) return [...catalog, template];
  return catalog.map((candidate, index) => index === existingIndex ? { ...candidate, ...template } : candidate);
}

export interface CompositionTemplateResolution {
  template?: AdditiveCompositionTemplate;
  ambiguous: boolean;
}

function technicalFingerprint(template: AdditiveCompositionTemplate): string {
  return JSON.stringify({
    bank: normalizeAdditiveCatalogBank(template.bank),
    description: template.description,
    unit: template.unit,
    unitPriceNoBDIInformed: template.unitPriceNoBDIInformed,
    analyticReferenceUnitPriceNoBDI: template.analyticReferenceUnitPriceNoBDI,
    inputs: template.inputs.map(input => ({
      code: input.code,
      bank: input.bank,
      description: input.description,
      unit: input.unit,
      coefficient: input.coefficient,
      unitPrice: input.unitPrice,
      total: input.total,
    })),
  });
}

export function resolveAdditiveCompositionTemplate(
  catalog: AdditiveCompositionTemplate[] = [],
  activeCompositions: AdditiveComposition[] = [],
  targetId: string,
  code: string,
  bank?: string,
): CompositionTemplateResolution {
  const normalizedCode = normalizeAdditiveCatalogCode(code);
  if (!normalizedCode) return { ambiguous: false };

  let candidates = catalog.filter(candidate =>
    (candidate.normalizedCode || normalizeAdditiveCatalogCode(candidate.code)) === normalizedCode,
  );
  for (const composition of activeCompositions) {
    if (composition.id === targetId || !composition.isNewService) continue;
    if (normalizeAdditiveCatalogCode(composition.code) !== normalizedCode) continue;
    const template = compositionTemplateFrom(composition);
    if (template) candidates = [...candidates, template];
  }

  const normalizedBank = normalizeAdditiveCatalogBank(bank);
  if (normalizedBank) {
    candidates = candidates.filter(candidate => normalizeAdditiveCatalogBank(candidate.bank) === normalizedBank);
  }

  const unique = new Map<string, AdditiveCompositionTemplate>();
  for (const candidate of candidates) {
    unique.set(technicalFingerprint(candidate), candidate);
  }
  const definitions = Array.from(unique.values());
  return definitions.length === 1
    ? { template: definitions[0], ambiguous: false }
    : { ambiguous: definitions.length > 1 };
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
