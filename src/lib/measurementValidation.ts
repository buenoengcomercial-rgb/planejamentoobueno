import type { SavedMeasurement } from '@/types/project';

export type ValidationLevel = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  level: ValidationLevel;
  code: string;
  message: string;
  /** taskIds afetados (quando aplicável). */
  affectedTaskIds?: string[];
}

export interface MinimalRow {
  taskId: string;
  description: string;
  itemCode: string;
  priceBank: string;
  unitPriceNoBDI: number;
  qtyContracted: number;
  qtyPeriod: number;
  qtyPriorAccum: number;
  qtyCurrentAccum: number;
  qtyBalance: number;
}

export type ValidationMode = 'generation' | 'fiscal-review';

export interface ValidationContext {
  startDate: string;
  endDate: string;
  measurementNumber: string | number;
  rows: MinimalRow[];
  measurements: SavedMeasurement[];
  contract: {
    contractor?: string;
    contracted?: string;
    contractNumber?: string;
    contractObject?: string;
    location?: string;
    budgetSource?: string;
    bdiPercent?: number;
  };
  /** Resumo opcional dos Diários de Obra do período (para gerar avisos). */
  dailyReports?: {
    missingReports: number;
    productionWithoutReportDays: number;
    impedimentDays: number;
  };
}

/** Retorna verdadeiro se [aStart..aEnd] e [bStart..bEnd] se cruzam. */
function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Roda toda a bateria de validações da medição.
 *
 * - mode = 'generation' (default): permite gerar medição apenas para planejamento.
 *   "Sem itens medidos" vira info, e diários/impedimentos são apenas avisos.
 * - mode = 'fiscal-review': validação mais rigorosa para envio à fiscalização.
 *   "Sem itens medidos" vira erro bloqueante.
 */
export function validateMeasurement(
  ctx: ValidationContext,
  options: { mode?: ValidationMode } = {},
): ValidationIssue[] {
  const mode: ValidationMode = options.mode || 'generation';
  const issues: ValidationIssue[] = [];
  const { startDate, endDate, measurementNumber, rows, measurements, contract, dailyReports } = ctx;

  // 1) Período
  if (!startDate || !endDate) {
    issues.push({ level: 'error', code: 'period-missing', message: 'Período da medição inválido. Preencha as datas inicial e final.' });
  } else if (startDate > endDate) {
    issues.push({ level: 'error', code: 'period-inverted', message: 'Período da medição inválido. A data inicial não pode ser maior que a data final.' });
  }

  // 2) Sobreposição com medições já geradas
  if (startDate && endDate && startDate <= endDate) {
    const overlapping = measurements.filter(m => intervalsOverlap(startDate, endDate, m.startDate, m.endDate));
    if (overlapping.length > 0) {
      const numbers = overlapping.map(m => `Nº ${m.number}`).join(', ');
      issues.push({
        level: 'error',
        code: 'period-overlap',
        message: `Este período cruza com medição(ões) já gerada(s): ${numbers}.`,
      });
    }
  }

  // 3) Número duplicado
  const num = Number(measurementNumber);
  if (Number.isFinite(num) && num > 0) {
    const dup = measurements.find(m => m.number === num);
    if (dup) {
      issues.push({ level: 'error', code: 'number-duplicated', message: `Já existe uma medição com este número (Nº ${num}).` });
    }
  }

  // Itens medidos no período
  const measuredRows = rows.filter(r => (r.qtyPeriod || 0) > 0);

  // 9) Sem itens medidos — bloqueia apenas no envio à fiscalização.
  if (measuredRows.length === 0) {
    if (mode === 'fiscal-review') {
      issues.push({
        level: 'error',
        code: 'no-items',
        message: 'Não há itens medidos neste período. Não é possível enviar à fiscalização sem produção.',
      });
    } else {
      issues.push({
        level: 'info',
        code: 'no-items',
        message: 'Não há itens medidos neste período. A medição será gerada apenas para planejamento/previsão.',
      });
    }
  }

  // 5) Itens sem preço
  const noPrice = measuredRows.filter(r => !r.unitPriceNoBDI || r.unitPriceNoBDI <= 0);
  if (noPrice.length > 0) {
    issues.push({
      level: 'warning',
      code: 'items-without-price',
      message: `Existem ${noPrice.length} item(ns) sem preço unitário s/ BDI.`,
      affectedTaskIds: noPrice.map(r => r.taskId),
    });
  }

  // 6) Itens sem código/banco
  const noCodeOrBank = measuredRows.filter(r => !r.itemCode?.trim() || !r.priceBank?.trim());
  if (noCodeOrBank.length > 0) {
    issues.push({
      level: 'warning',
      code: 'items-without-code',
      message: `Existem ${noCodeOrBank.length} item(ns) sem código ou banco de referência.`,
      affectedTaskIds: noCodeOrBank.map(r => r.taskId),
    });
  }

  // 7) Quantidade do período > saldo a executar
  const overBalance = rows.filter(r => {
    const balance = (r.qtyContracted || 0) - (r.qtyPriorAccum || 0);
    return (r.qtyPeriod || 0) > balance + 1e-9;
  });
  if (overBalance.length > 0) {
    issues.push({
      level: 'error',
      code: 'qty-over-balance',
      message: `Existem ${overBalance.length} item(ns) com quantidade medida maior que o saldo a executar.`,
      affectedTaskIds: overBalance.map(r => r.taskId),
    });
  }

  // 8) Acumulado > contratado
  const overContracted = rows.filter(r => (r.qtyCurrentAccum || 0) > (r.qtyContracted || 0) + 1e-9);
  if (overContracted.length > 0) {
    issues.push({
      level: 'error',
      code: 'accum-over-contracted',
      message: `Existem ${overContracted.length} item(ns) com acumulado maior que a quantidade contratada.`,
      affectedTaskIds: overContracted.map(r => r.taskId),
    });
  }

  // 10) Dados contratuais
  const missingContract: string[] = [];
  if (!contract.contractor?.trim()) missingContract.push('Contratante');
  if (!contract.contracted?.trim()) missingContract.push('Contratada');
  if (!contract.contractNumber?.trim()) missingContract.push('Nº do contrato');
  if (!contract.budgetSource?.trim()) missingContract.push('Fonte de orçamento');
  if (contract.bdiPercent === undefined || contract.bdiPercent === null) missingContract.push('BDI');
  if (!contract.contractObject?.trim()) missingContract.push('Objeto');
  if (!contract.location?.trim()) missingContract.push('Local/Município');
  if (missingContract.length > 0) {
    issues.push({
      level: 'warning',
      code: 'contract-incomplete',
      message: `Dados contratuais incompletos: ${missingContract.join(', ')}.`,
    });
  }

  // 11) Diários de Obra do período (avisos, não bloqueiam)
  if (dailyReports) {
    if (dailyReports.missingReports > 0) {
      issues.push({
        level: 'warning',
        code: 'daily-reports-pending',
        message: `Existem ${dailyReports.missingReports} diário(s) de obra pendente(s) no período da medição.`,
      });
    }
    if (dailyReports.productionWithoutReportDays > 0) {
      issues.push({
        level: 'warning',
        code: 'production-without-report',
        message: `Existem ${dailyReports.productionWithoutReportDays} dia(s) com produção apontada, mas sem diário preenchido.`,
      });
    }
    if (dailyReports.impedimentDays > 0) {
      issues.push({
        level: 'warning',
        code: 'impediments-in-period',
        message: `Existem ${dailyReports.impedimentDays} dia(s) com impedimentos registrados no período.`,
      });
    }
  }

  return issues;
}

/** Helper: validação para gerar a medição (modo planejamento). */
export function validateMeasurementForGeneration(ctx: ValidationContext): ValidationIssue[] {
  return validateMeasurement(ctx, { mode: 'generation' });
}

/** Helper: validação para envio à fiscalização (mais rigorosa). */
export function validateMeasurementForFiscalReview(ctx: ValidationContext): ValidationIssue[] {
  return validateMeasurement(ctx, { mode: 'fiscal-review' });
}

export function summarizeIssues(issues: ValidationIssue[]) {
  const errors = issues.filter(i => i.level === 'error').length;
  const warnings = issues.filter(i => i.level === 'warning').length;
  const infos = issues.filter(i => i.level === 'info').length;
  return { errors, warnings, infos, hasBlocking: errors > 0 };
}

