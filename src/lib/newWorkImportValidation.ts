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
  syntheticErrors?: string[];
  unresolvedStructuralGroups?: string[];
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

function analyticFingerprint(composition: AdditiveComposition) {
  return JSON.stringify((composition.inputs ?? []).map(input => [
    normalizeCode(input.code),
    input.bank.trim().toUpperCase(),
    input.description.trim().toUpperCase(),
    input.unit.trim().toUpperCase(),
    Number(input.coefficient),
    Number(input.unitPrice),
  ]));
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
  const availableByCode = new Set<string>();
  for (const composition of analyticCompositions ?? []) {
    if ((composition.inputs?.length ?? 0) === 0) continue;
    const key = normalizeCode(composition.code);
    if (key) availableByCode.add(key);
  }

  const missing: UnlinkedAnalyticItem[] = [];
  for (const budget of budgetItems) {
    const key = normalizeCode(budget.code);
    if (key && availableByCode.has(key)) {
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
  const errors: string[] = [...(input.syntheticErrors ?? [])];
  const contractBdi = input.contractBdiPercent;

  if (contractBdi === undefined || !Number.isFinite(contractBdi) || contractBdi < 0 || contractBdi >= 200) {
    errors.push('Informe um BDI válido para confirmar o orçamento.');
  }

  const byCode = new Map<string, AdditiveComposition>();
  for (const composition of input.analyticCompositions ?? []) {
    const code = normalizeCode(composition.code);
    if (!code) continue;
    const previous = byCode.get(code);
    if (previous && analyticFingerprint(previous) !== analyticFingerprint(composition)) {
      errors.push(`O cÃ³digo AnalÃ­tico ${composition.code} aparece com insumos, coeficientes ou preÃ§os diferentes.`);
    } else if (!previous) {
      byCode.set(code, composition);
    }
  }

  const missingAnalytics = findMissingAnalyticItems(input.budgetItems, input.analyticCompositions);
  if (missingAnalytics.length > 0) {
    errors.push(`${missingAnalytics.length} serviço(s) da Sintética estão sem composição Analítica vinculada.`);
  }
  if ((input.unresolvedStructuralGroups?.length ?? 0) > 0) {
    errors.push(`Corrija a descricao de: ${input.unresolvedStructuralGroups!.join(', ')}.`);
  }

  return { errors, missingAnalytics, isValid: errors.length === 0 };
}
