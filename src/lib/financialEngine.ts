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
  unitPriceNoBDIWithDiscount: number;
  unitPriceWithBDI: number;
}

/** Preços de um novo serviço acrescido (referência → desconto → BDI). */
export function calculateNewServiceUnitPrices(input: NewServiceUnitPricesInput): NewServiceUnitPricesResult {
  const referenceUnitNoBDI = money2(input.referenceUnitNoBDI);
  const unitPriceNoBDIWithDiscount = calculateDiscountedUnitNoBDI(referenceUnitNoBDI, input.discountPercent);
  const unitPriceWithBDI = calculateUnitPriceWithBDI(unitPriceNoBDIWithDiscount, input.bdiPercent);
  return { referenceUnitNoBDI, unitPriceNoBDIWithDiscount, unitPriceWithBDI };
}

export interface AnalyticInputLike {
  coefficient?: number | null;
  unitPrice?: number | null;
  /** Total já vindo da planilha (opcional). */
  total?: number | null;
}

/** Soma os totais s/ BDI dos insumos da composição analítica. */
export function calculateAnalyticTotalNoBDI(inputs: AnalyticInputLike[]): number {
  let acc = 0;
  for (const i of inputs ?? []) {
    const hasTotal = i.total !== null && i.total !== undefined && Number.isFinite(Number(i.total));
    const t = hasTotal
      ? money2(i.total as number)
      : trunc2((Number(i.coefficient) || 0) * (Number(i.unitPrice) || 0));
    acc = money2(acc + t);
  }
  return money2(acc);
}

/** Soma os totais s/ BDI dos insumos com desconto global aplicado em cada insumo. */
export function calculateDiscountedAnalyticTotalNoBDI(inputs: AnalyticInputLike[], discountPercent: number): number {
  let acc = 0;
  for (const i of inputs ?? []) {
    const unitDisc = calculateDiscountedUnitNoBDI(Number(i.unitPrice) || 0, discountPercent);
    const totalDisc = trunc2(unitDisc * (Number(i.coefficient) || 0));
    acc = money2(acc + totalDisc);
  }
  return money2(acc);
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
}
