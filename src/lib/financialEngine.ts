/**
 * Motor financeiro único de todo o sistema.
 *
 * Regras oficiais:
 * - Valores CALCULADOS pelo sistema → trunc2 (truncar, nunca arredondar para cima)
 * - Valores que JÁ vêm prontos da planilha Excel → money2 (arredondamento seguro)
 *
 * Toda a Medição, Aditivo, importação e exportação devem passar por aqui.
 * Não criar regra paralela de BDI, desconto ou truncamento em outros arquivos.
 */

/**
 * Trunca em 2 casas decimais. Nunca arredonda para cima.
 *
 * O pequeno ajuste abaixo corrige apenas resíduos binários do JavaScript
 * (ex.: 9601.97 * 2 vira 19203.939999999995), sem transformar
 * valores reais com terceira casa decimal em arredondamento.
 */
export function trunc2(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const scaled = n * 100;
  const epsilon = scaled >= 0 ? 1e-9 : -1e-9;
  return Math.trunc(scaled + epsilon) / 100;
}

/**
 * Normaliza em 2 casas valores que já vêm prontos da planilha Excel.
 * Use apenas para preservar valores importados (Sintética) ou já calculados pela fonte.
 */
export function money2(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Soma valores monetários já finalizados usando centavos inteiros.
 *
 * Não recalcula nem arredonda as linhas: apenas impede que resíduos binários
 * do JavaScript virem perdas de centavos durante a acumulação.
 */
export function sumMoney(values: Iterable<number | null | undefined>): number {
  let cents = 0;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    cents += Math.round(n * 100);
  }
  return cents / 100;
}

/** Preço unitário c/ BDI: trunc2(unit × (1 + bdi/100)). */
export function calculateUnitPriceWithBDI(unitPriceNoBDI: number, bdiPercent: number): number {
  const u = Number(unitPriceNoBDI) || 0;
  const b = Number.isFinite(bdiPercent) ? Math.max(0, bdiPercent) : 0;
  return trunc2(u * (1 + b / 100));
}

/** Preço unitário s/ BDI já com desconto global aplicado. */
export function calculateDiscountedUnitNoBDI(referenceUnitNoBDI: number, discountPercent: number): number {
  const u = Number(referenceUnitNoBDI) || 0;
  const d = Number.isFinite(discountPercent) ? Math.max(0, Math.min(100, discountPercent)) : 0;
  return trunc2(u * (1 - d / 100));
}

/** Total de uma linha: trunc2(unit × qty). */
export function calculateLineTotal(unitPrice: number, quantity: number): number {
  const u = Number(unitPrice) || 0;
  const q = Number(quantity) || 0;
  return trunc2(u * q);
}

export interface NewServiceUnitPricesInput {
  referenceUnitNoBDI: number;
  discountPercent: number;
  bdiPercent: number;
}

export interface NewServiceUnitPricesResult {
  referenceUnitNoBDI: number;
  /** Valor s/ BDI com o desconto global, apenas informativo. */
  unitPriceNoBDIWithDiscount: number;
  /** Parcela de BDI truncada antes da soma, conforme a planilha da Administração. */
  bdiAmount: number;
  /** Referência + BDI, antes de aplicar o desconto licitatório. */
  unitPriceWithBDIBeforeDiscount: number;
  /** Valor final: BDI primeiro, desconto global por último. */
  unitPriceWithBDI: number;
}

/**
 * Preços de um novo serviço acrescido segundo a Administração:
 *   referência → BDI truncado → soma truncada → desconto global truncado.
 *
 * O valor s/ BDI com desconto continua disponível apenas para conferência;
 * ele NÃO é usado como base para calcular o BDI.
 */
export function calculateNewServiceUnitPrices(input: NewServiceUnitPricesInput): NewServiceUnitPricesResult {
  const referenceUnitNoBDI = money2(input.referenceUnitNoBDI);
  const unitPriceNoBDIWithDiscount = calculateDiscountedUnitNoBDI(referenceUnitNoBDI, input.discountPercent);
  const bdi = Number.isFinite(input.bdiPercent) ? Math.max(0, input.bdiPercent) : 0;
  const discount = Number.isFinite(input.discountPercent)
    ? Math.max(0, Math.min(100, input.discountPercent))
    : 0;
  const bdiAmount = trunc2(referenceUnitNoBDI * (bdi / 100));
  const unitPriceWithBDIBeforeDiscount = trunc2(referenceUnitNoBDI + bdiAmount);
  const unitPriceWithBDI = trunc2(unitPriceWithBDIBeforeDiscount * (1 - discount / 100));
  return {
    referenceUnitNoBDI,
    unitPriceNoBDIWithDiscount,
    bdiAmount,
    unitPriceWithBDIBeforeDiscount,
    unitPriceWithBDI,
  };
}

export interface AnalyticInputLike {
  coefficient?: number | null;
  unitPrice?: number | null;
  /** Total já vindo da planilha (opcional). */
  total?: number | null;
}

export type AnalyticTotalPolicy =
  | 'recalculate_lines_trunc2'
  | 'preserve_source_total';

/**
 * Total s/ BDI de um insumo analítico.
 *
 * - Administração: recalcula coeficiente × valor unitário e trunca a linha.
 * - Legado: preserva o Total explícito da fonte quando ele existir.
 */
export function calculateAnalyticLineTotal(
  input: AnalyticInputLike,
  policy: AnalyticTotalPolicy = 'preserve_source_total',
): number {
  if (policy === 'recalculate_lines_trunc2') {
    return calculateLineTotal(Number(input.unitPrice) || 0, Number(input.coefficient) || 0);
  }
  const hasSourceTotal = input.total !== null
    && input.total !== undefined
    && Number.isFinite(Number(input.total));
  return hasSourceTotal
    ? money2(Number(input.total))
    : calculateLineTotal(Number(input.unitPrice) || 0, Number(input.coefficient) || 0);
}

/** Soma os totais s/ BDI dos insumos da composição analítica. */
export function calculateAnalyticTotalNoBDI(
  inputs: AnalyticInputLike[],
  policy: AnalyticTotalPolicy = 'preserve_source_total',
): number {
  let acc = 0;
  for (const i of inputs ?? []) {
    const t = calculateAnalyticLineTotal(i, policy);
    acc = trunc2(acc + t);
  }
  return trunc2(acc);
}

/**
 * Aplica o desconto uma única vez sobre a soma analítica.
 * Nunca desconta ou trunca cada insumo separadamente.
 */
export function calculateDiscountedAnalyticTotalNoBDI(
  inputs: AnalyticInputLike[],
  discountPercent: number,
  policy: AnalyticTotalPolicy = 'preserve_source_total',
): number {
  return calculateDiscountedUnitNoBDI(calculateAnalyticTotalNoBDI(inputs, policy), discountPercent);
}

// ---------------------------------------------------------------------------
// Validações internas (sanity checks). Roda em dev para garantir as regras.
// ---------------------------------------------------------------------------
if (import.meta.env?.DEV) {
  const assertEq = (label: string, got: number, expected: number) => {
    if (Math.abs(got - expected) > 1e-9) {
      // eslint-disable-next-line no-console
      console.error(`[financialEngine] ${label}: esperado ${expected}, obtido ${got}`);
    }
  };
  assertEq('trunc2(10.999)', trunc2(10.999), 10.99);
  assertEq('calculateUnitPriceWithBDI(424.83, 27.58)', calculateUnitPriceWithBDI(424.83, 27.58), 541.99);
  assertEq('calculateDiscountedUnitNoBDI(4430.70, 6)', calculateDiscountedUnitNoBDI(4430.70, 6), 4164.85);
  assertEq('calculateLineTotal(5313.52, 6)', calculateLineTotal(5313.52, 6), 31881.12);
  assertEq(
    'calculateNewServiceUnitPrices(2775.03, 27.58, 6)',
    calculateNewServiceUnitPrices({ referenceUnitNoBDI: 2775.03, bdiPercent: 27.58, discountPercent: 6 }).unitPriceWithBDI,
    3327.95,
  );
}
