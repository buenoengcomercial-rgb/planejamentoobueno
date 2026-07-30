import type { AdditiveComposition, BudgetItem } from '@/types/project';

export interface UnlinkedAnalyticItem {
  item: string;
  code: string;
  description: string;
  reason: string;
}

export interface NewWorkImportValidationInput {
  contractBdiPercent?: number;
  detectedBdiPercent?: number;
  budgetItems: BudgetItem[];
  analyticCompositions: AdditiveComposition[] | null | undefined;
}

export interface NewWorkImportValidation {
  errors: string[];
  missingAnalytics: UnlinkedAnalyticItem[];
  isValid: boolean;
}

function normalizeItem(value?: string) {
  return (value ?? '')
    .trim()
    .split('.')
    .map(part => /^\d+$/.test(part) ? String(Number(part)) : part)
    .join('.');
}

function normalizeCode(value?: string) {
  const source = (value ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const match = source.match(/^([A-Z]+)(0+)(\d+)(.*)$/);
  return match ? `${match[1]}${match[3]}${match[4]}` : source;
}

function keyOf(item?: string, code?: string) {
  return `${normalizeItem(item)}|${normalizeCode(code)}`;
}

/**
 * Retorna os serviços que não têm uma composição Analítica com ao menos um
 * insumo. A fila por item+código evita que códigos repetidos consumam a mesma
 * composição por engano.
 */
export function findMissingAnalyticItems(
  budgetItems: BudgetItem[],
  analyticCompositions: AdditiveComposition[] | null | undefined,
): UnlinkedAnalyticItem[] {
  const availableByKey = new Map<string, number>();
  for (const composition of analyticCompositions ?? []) {
    if ((composition.inputs?.length ?? 0) === 0) continue;
    const key = keyOf(composition.item ?? composition.itemNumber, composition.code);
    if (!key || key === '|') continue;
    availableByKey.set(key, (availableByKey.get(key) ?? 0) + 1);
  }

  const missing: UnlinkedAnalyticItem[] = [];
  for (const budget of budgetItems) {
    const key = keyOf(budget.item, budget.code);
    const remaining = availableByKey.get(key) ?? 0;
    if (remaining > 0) {
      availableByKey.set(key, remaining - 1);
      continue;
    }
    missing.push({
      item: budget.item,
      code: budget.code,
      description: budget.description,
      reason: 'Composição Analítica não encontrada ou sem insumos.',
    });
  }
  return missing;
}

/** Regras obrigatórias antes de criar uma obra nova por importação. */
export function validateNewWorkImport(input: NewWorkImportValidationInput): NewWorkImportValidation {
  const errors: string[] = [];
  const contractBdi = input.contractBdiPercent;
  const detectedBdi = input.detectedBdiPercent;

  if (contractBdi === undefined || !Number.isFinite(contractBdi) || contractBdi < 0 || contractBdi >= 200) {
    errors.push('Informe um BDI válido para confirmar o orçamento.');
  } else if (
    detectedBdi !== undefined
    && Number.isFinite(detectedBdi)
    && Math.abs(contractBdi - detectedBdi) > 0.005
  ) {
    errors.push(`O BDI informado (${contractBdi.toFixed(2)}%) diverge do BDI da planilha (${detectedBdi.toFixed(2)}%).`);
  }

  const missingAnalytics = findMissingAnalyticItems(input.budgetItems, input.analyticCompositions);
  if (missingAnalytics.length > 0) {
    errors.push(`${missingAnalytics.length} serviço(s) da Sintética estão sem composição Analítica vinculada.`);
  }

  return { errors, missingAnalytics, isValid: errors.length === 0 };
}
