import type {
  AdditiveComposition,
  AdditiveCalculationMemoryRow,
  AdditiveCalculationMemoryColumns,
} from '@/types/project';
import { DEFAULT_MEMORY_COLUMN_LABELS } from '@/types/project';

/** Resolve os rótulos visíveis das colunas dimensionais (A,B,C,D), aplicando defaults quando faltarem. */
export function resolveMemoryColumnLabels(
  cols?: AdditiveCalculationMemoryColumns,
): Required<AdditiveCalculationMemoryColumns> {
  return {
    a: (cols?.a ?? '').trim() || DEFAULT_MEMORY_COLUMN_LABELS.a,
    b: (cols?.b ?? '').trim() || DEFAULT_MEMORY_COLUMN_LABELS.b,
    c: (cols?.c ?? '').trim() || DEFAULT_MEMORY_COLUMN_LABELS.c,
    d: (cols?.d ?? '').trim() || DEFAULT_MEMORY_COLUMN_LABELS.d,
  };
}

const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Avaliador seguro de fórmulas de memória de cálculo.
 * Permite apenas: dígitos, ponto, vírgula, espaços, parênteses, +-*\/, e variáveis A,B,C,D.
 * Retorna `{ value, ok, error }`. Se `ok=false`, `value` é 0.
 */
export function evalMemoryFormula(
  formula: string,
  vars: { a?: number; b?: number; c?: number; d?: number },
): { value: number; ok: boolean; error?: string } {
  const raw = (formula ?? '').trim();
  if (!raw) {
    // Cálculo padrão: A * B * C * D, com regras de "vazio".
    const a = vars.a ?? 0;       // A vazio = 0
    const b = vars.b == null ? 1 : vars.b;
    const c = vars.c == null ? 1 : vars.c;
    const d = vars.d == null ? 1 : vars.d;
    const value = a * b * c * d;
    return { value: Number.isFinite(value) ? value : 0, ok: true };
  }
  // Normaliza vírgula decimal e remove espaços.
  let expr = raw.replace(/,/g, '.').replace(/\s+/g, '');
  // Whitelist de caracteres.
  if (!/^[0-9.+\-*/()ABCDabcd]+$/.test(expr)) {
    return { value: 0, ok: false, error: 'Caracteres não permitidos.' };
  }
  // Substitui variáveis (case-insensitive). Se variável não definida, vale 0.
  const subst = (k: 'a' | 'b' | 'c' | 'd') => {
    const v = vars[k];
    return `(${Number.isFinite(v as number) ? Number(v) : 0})`;
  };
  expr = expr
    .replace(/[Aa]/g, subst('a'))
    .replace(/[Bb]/g, subst('b'))
    .replace(/[Cc]/g, subst('c'))
    .replace(/[Dd]/g, subst('d'));
  // Após substituição, só pode haver dígitos, ponto, +-*/, parênteses.
  if (!/^[0-9.+\-*/()]+$/.test(expr)) {
    return { value: 0, ok: false, error: 'Fórmula inválida.' };
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict";return (${expr});`);
    const value = Number(fn());
    if (!Number.isFinite(value)) {
      return { value: 0, ok: false, error: 'Resultado não numérico.' };
    }
    return { value, ok: true };
  } catch {
    return { value: 0, ok: false, error: 'Erro ao avaliar fórmula.' };
  }
}

/** Recalcula `partial` de uma linha de memória usando a fórmula/variáveis informadas. */
export function recalcMemoryRow(
  row: AdditiveCalculationMemoryRow,
): AdditiveCalculationMemoryRow {
  const r = evalMemoryFormula(row.formula ?? '', {
    a: row.a, b: row.b, c: row.c, d: row.d,
  });
  return { ...row, partial: r.ok ? r.value : 0 };
}

/** Cria nova linha de memória vazia. */
export function makeMemoryRow(
  type: 'acrescida' | 'suprimida' = 'acrescida',
): AdditiveCalculationMemoryRow {
  return {
    id: uid(),
    type,
    loc: '',
    comment: '',
    formula: '',
    a: undefined,
    b: undefined,
    c: undefined,
    d: undefined,
    partial: 0,
  };
}

/** Considera a linha "preenchida" se tiver qualquer dado significativo (exceto somente o tipo). */
export function isMemoryRowFilled(row: AdditiveCalculationMemoryRow): boolean {
  if (!row) return false;
  const txt = (s?: string) => !!(s && s.trim() !== '');
  const num = (n?: number) => Number.isFinite(n as number);
  return txt(row.comment) || txt(row.formula) || num(row.a) || num(row.b) || num(row.c) || num(row.d);
}

/** Retorna apenas as linhas preenchidas (descartando rascunho/linha vazia visual). */
export function validMemoryRows(
  rows: AdditiveCalculationMemoryRow[] | undefined,
): AdditiveCalculationMemoryRow[] {
  return (rows ?? []).filter(isMemoryRowFilled);
}

/** Soma dos parciais por tipo dentro da memória da composição (considera apenas linhas preenchidas). */
export function memoryTotals(comp: AdditiveComposition): {
  added: number;
  suppressed: number;
  hasMemory: boolean;
} {
  const rows = validMemoryRows(comp.calculationMemory);
  if (rows.length === 0) return { added: 0, suppressed: 0, hasMemory: false };
  let added = 0;
  let suppressed = 0;
  for (const r of rows) {
    const p = Number.isFinite(r.partial) ? r.partial : 0;
    if (r.type === 'suprimida') suppressed += p;
    else added += p;
  }
  // Truncar em 2 casas: as quantidades resultantes alimentam cálculos financeiros.
  const t2 = (n: number) => {
    if (!Number.isFinite(n)) return 0;
    const scaled = n * 100;
    const eps = scaled >= 0 ? 1e-9 : -1e-9;
    return Math.trunc(scaled + eps) / 100;
  };
  return { added: t2(added), suppressed: t2(suppressed), hasMemory: true };
}

/**
 * Aplica a memória de cálculo nas quantidades da composição.
 * Quando `calculationMemory` existe e tem linhas, sobrescreve `addedQuantity` e `suppressedQuantity`.
 */
export function applyMemoryToComposition(
  comp: AdditiveComposition,
): AdditiveComposition {
  const t = memoryTotals(comp);
  if (!t.hasMemory) return comp;
  return {
    ...comp,
    addedQuantity: t.added,
    suppressedQuantity: t.suppressed,
  };
}
