import type {
  Additive,
  AdditiveComposition,
  AdditiveInput,
  AdditiveImportIssue,
  AdditiveChangeKind,
  BudgetItem,
  Project,
  Task,
  Phase,
} from '@/types/project';
import { getChapterTree, getChapterNumbering, type ChapterNode } from '@/lib/chapters';
import { resolveMemoryColumnLabels, validMemoryRows } from '@/lib/calculationMemory';

const uid = () => Math.random().toString(36).slice(2, 10);

function toNumber(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v).trim();
  if (!s) return 0;
  s = s.replace(/[^\d.,\-]/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// Motor financeiro único — não duplicar regras aqui.
import { trunc2 as _trunc2, money2 as _money2 } from './financialEngine';

/** Alias histórico — usar trunc2 do financialEngine. */
export function truncar2(v: number): number {
  return _trunc2(v);
}

export function money2(value: number | null | undefined): number {
  return _money2(value);
}

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

/**
 * Normaliza código para casamento Sintética x Analítica.
 * Remove zeros à esquerda da parte numérica imediatamente após letras
 * (ADM04 -> ADM4, C0002 -> C2). Mantém códigos puramente numéricos com zeros.
 */
function normalizeCode(raw: string): string {
  if (!raw) return '';
  let s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  s = s.replace(/[\u00A0\u200B-\u200D\uFEFF]/g, '');
  const m = s.match(/^([A-Z]+)(0+)(\d+)(.*)$/);
  if (m) return `${m[1]}${m[3]}${m[4]}`;
  return s;
}

function findSheetName(names: string[], target: string): string | undefined {
  const t = norm(target);
  return names.find(n => norm(n) === t) || names.find(n => norm(n).includes(t));
}

function sheetToRows(ws: any, XLSX: any): unknown[][] {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as unknown[][];
}

/** Procura linha de cabeçalho contendo termos típicos. */
function detectHeaderIndex(rows: unknown[][]): number {
  const HINTS = ['item', 'codigo', 'código', 'descricao', 'descrição', 'banco', 'unidade'];
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = (rows[i] || []).map(c => norm(asString(c))).join(' | ');
    let hits = 0;
    for (const h of HINTS) if (joined.includes(norm(h))) hits++;
    if (hits >= 3) return i;
  }
  return 0;
}

/** Lê BDI percentual da célula J8 (linha 8, coluna J = índice 9) da Sintética. */
function extractBdiFromJ8(rows: unknown[][]): number | undefined {
  const direct = toNumber(rows[7]?.[9]);
  if (direct > 0 && direct < 200) return direct;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const r = rows[i] || [];
    for (let c = 0; c < r.length; c++) {
      const v = norm(asString(r[c]));
      if (v.includes('bdi')) {
        for (let cc = c + 1; cc < r.length; cc++) {
          const n = toNumber(r[cc]);
          if (n > 0 && n < 200) return n;
        }
      }
    }
  }
  return undefined;
}

interface SyntheticRow {
  item: string;
  code: string;
  bank: string;
  description: string;
  quantity: number;
  unit: string;
  unitPriceNoBDI: number;
  unitPriceWithBDI: number;
  total: number;
  rowIndex: number;
}

interface AnalyticRow {
  code: string;
  bank: string;
  description: string;
  unit: string;
  coefficient: number;
  unitPrice: number;
  total: number;
  rowIndex: number;
}

interface AnalyticBlock {
  normCode: string;
  code: string;
  item: string;
  inputs: AnalyticRow[];
  parentTotalNoBDI?: number;
  analyticUnitPriceWithBDI?: number;
  startRow: number;
}

/**
 * Verifica se a planilha tem cabeçalhos compatíveis com Analítica.
 * Procura nos primeiros 30 linhas por cabeçalhos típicos.
 */
function looksLikeAnalyticSheet(rows: unknown[][]): boolean {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = (rows[i] || []).map(c => norm(asString(c)));
    const joined = cells.join(' | ');
    const hasItem = cells.some(c => c === 'item' || c.startsWith('item'));
    const hasCodigo = joined.includes('codigo') || joined.includes('código');
    const hasBanco = cells.some(c => c === 'banco' || c.startsWith('banco'));
    const hasDesc = joined.includes('descricao') || joined.includes('descrição');
    const hasQuant = cells.some(c => c === 'quant' || c.startsWith('quant') || c === 'coef' || c.startsWith('coef'));
    const hasUn = cells.some(c => c === 'un' || c === 'und' || c === 'unid' || c.startsWith('unid'));
    const hits = [hasItem, hasCodigo, hasBanco, hasDesc, hasQuant, hasUn].filter(Boolean).length;
    if (hits >= 4) return true;
  }
  return false;
}

/**
 * Parser SINTÉTICA — layout fixo A..J.
 */
function parseSyntheticSheet(rows: unknown[][]): { items: SyntheticRow[]; issues: AdditiveImportIssue[]; bdi?: number } {
  const issues: AdditiveImportIssue[] = [];
  const headerIdx = detectHeaderIndex(rows);
  const items: SyntheticRow[] = [];
  const bdi = extractBdiFromJ8(rows);

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const item = asString(r[0]);
    const code = asString(r[1]);
    const bank = asString(r[2]);
    const description = asString(r[3]);
    const quantity = toNumber(r[4]);
    const unit = asString(r[5]);
    const unitPriceNoBDI = toNumber(r[6]);
    const total = toNumber(r[7]);
    const unitPriceWithBDI = toNumber(r[8]);

    if (!item && !code && !bank && !description && !quantity && !total && !unitPriceNoBDI) continue;
    const lowDesc = norm(description);
    if (!code && (lowDesc.includes('total') || lowDesc.includes('subtotal'))) continue;
    if (!bank) continue; // capítulos
    if (!code) continue;

    if (quantity <= 0) {
      issues.push({ level: 'warning', message: `Quantidade inválida ou zero (${code})`, code, line: i + 1 });
    }
    if (unitPriceNoBDI <= 0) {
      issues.push({ level: 'warning', message: `Valor unit. s/ BDI inválido (${code})`, code, line: i + 1 });
    }

    items.push({
      item, code, bank, description, quantity, unit,
      unitPriceNoBDI,
      unitPriceWithBDI: unitPriceWithBDI || 0,
      total: total || +(unitPriceNoBDI * quantity).toFixed(2),
      rowIndex: i + 1,
    });
  }

  return { items, issues, bdi };
}

/**
 * Verifica se a célula da coluna A indica um item de insumo da analítica.
 * Aceita: "Insumo", "Auxiliar", "Comp. Auxiliar", "Comp Auxiliar", "Composição Auxiliar".
 */
function isAnalyticInsumoLine(aLow: string): boolean {
  if (!aLow) return false;
  if (aLow === 'insumo' || aLow.startsWith('insumo')) return true;
  if (aLow === 'auxiliar' || aLow.startsWith('auxiliar')) return true;
  // Comp. Auxiliar / Comp Auxiliar / Composicao Auxiliar / Composição Auxiliar
  if (/(^|\s)(comp\.?|composicao|composição)\s+aux/.test(aLow)) return true;
  return false;
}

/**
 * Parser ANALÍTICA.
 * Linha pai: A é numérico (item ex. "2.1.1") + B (código) + C (banco) preenchidos.
 * O bloco do pai termina apenas quando aparece a próxima linha pai.
 * Linhas com A = "Insumo"/"Auxiliar"/"Comp. Auxiliar"/etc são insumos.
 * Linha "Valor com BDI =" é ignorada como insumo.
 */
function parseAnalyticSheet(
  rows: unknown[][],
): { blocks: AnalyticBlock[]; issues: AdditiveImportIssue[] } {
  const issues: AdditiveImportIssue[] = [];
  const headerIdx = detectHeaderIndex(rows);
  const blocks: AnalyticBlock[] = [];
  let current: AnalyticBlock | null = null;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const aRaw = asString(r[0]);
    const codeRaw = asString(r[1]);
    const bank = asString(r[2]);
    const description = asString(r[3]);
    const coefficient = toNumber(r[4]);
    const unit = asString(r[5]);
    const unitPrice = toNumber(r[6]);
    const total = toNumber(r[7]);

    if (!aRaw && !codeRaw && !description && !coefficient && !unitPrice) continue;

    const aLow = norm(aRaw);
    const dLow = norm(description);

    // Linha "Valor com BDI =" → captura como analyticUnitPriceWithBDI do bloco atual e ignora como insumo
    if (
      dLow.includes('valor com bdi') ||
      aLow.includes('valor com bdi') ||
      norm(asString(r[6])).includes('valor com bdi') ||
      norm(asString(r[5])).includes('valor com bdi')
    ) {
      if (current) {
        const valWithBDI = toNumber(r[7]);
        if (valWithBDI > 0) {
          current.analyticUnitPriceWithBDI = valWithBDI;
        }
      }
      continue;
    }

    // Detecta linha pai: A é número (item tipo "1", "2.1.4") e B/C preenchidos.
    const isParentLine =
      !!codeRaw && !!bank && /^\d+(\.\d+)*$/.test(aRaw.replace(',', '.'));

    if (isParentLine) {
      current = {
        normCode: normalizeCode(codeRaw),
        code: codeRaw,
        item: aRaw.replace(',', '.'),
        inputs: [],
        parentTotalNoBDI: total > 0 ? total : undefined,
        startRow: i + 1,
      };
      blocks.push(current);
      continue;
    }

    if (!isAnalyticInsumoLine(aLow)) continue;
    if (!current) continue;
    if (!codeRaw && !description) continue;

    if (unitPrice <= 0) {
      issues.push({ level: 'warning', message: `Insumo sem preço (${codeRaw || description})`, line: i + 1 });
    }

    current.inputs.push({
      code: codeRaw, bank, description, unit, coefficient, unitPrice, total,
      rowIndex: i + 1,
    });
  }

  return { blocks, issues };
}

/** Resultado da importação de aditivo, com indicação do que foi lido. */
export interface AdditiveImportResult {
  /** Aditivo novo OU atualização a ser aplicada num existente. */
  additive: Additive;
  /** Modo de importação detectado. */
  mode: 'synthetic_only' | 'analytic_only' | 'both';
  /** Quando mode === 'analytic_only', os blocos analíticos crus para merge posterior. */
  pendingAnalyticBlocks?: AnalyticBlock[];
  /** Resumo das abas encontradas. */
  hasSynthetic: boolean;
  hasAnalytic: boolean;
  /** Mensagem amigável para o usuário. */
  message: string;
}

/** Apenas a Sintética → cria/atualiza um aditivo em rascunho com composições. */
export function parseAdditiveSyntheticWorkbook(
  rows: unknown[][],
  additiveName: string,
): { additive: Additive; bdiPercent: number; issues: AdditiveImportIssue[] } {
  const { items: synthItems, issues: synthIssues, bdi } = parseSyntheticSheet(rows);
  const issues: AdditiveImportIssue[] = [...synthIssues];
  const bdiPercent = bdi ?? 0;
  const fator = 1 + bdiPercent / 100;

  const compositions: AdditiveComposition[] = synthItems.map(s => {
    const unitPriceWithBDI = bdiPercent > 0
      ? truncar2(s.unitPriceNoBDI * fator)
      : (s.unitPriceWithBDI || truncar2(s.unitPriceNoBDI * fator));
    const total = truncar2(unitPriceWithBDI * s.quantity);
    return {
      id: uid(),
      item: s.item,
      code: s.code,
      bank: s.bank,
      description: s.description,
      quantity: s.quantity,
      unit: s.unit,
      unitPriceNoBDI: s.unitPriceNoBDI,
      unitPriceWithBDI,
      total,
      inputs: [],
      source: 'excel_aditivo',
      changeKind: 'acrescido',
      originalQuantity: 0,
      addedQuantity: s.quantity,
      suppressedQuantity: 0,
    };
  });

  const additive: Additive = {
    id: uid(),
    name: additiveName,
    importedAt: new Date().toISOString(),
    compositions,
    issues,
    bdiPercent,
    status: 'rascunho',
  };
  return { additive, bdiPercent, issues };
}

/** Apenas a Analítica → retorna blocos crus para merge. */
export function parseAdditiveAnalyticWorkbook(
  rows: unknown[][],
): { blocks: AnalyticBlock[]; issues: AdditiveImportIssue[] } {
  return parseAnalyticSheet(rows);
}

/**
 * Vincula blocos analíticos a um aditivo já existente (que tem composições da Sintética).
 * Retorna um NOVO Additive imutável com inputs preenchidos.
 */
export function mergeAnalyticIntoAdditive(
  additive: Additive,
  blocks: AnalyticBlock[],
): { additive: Additive; linked: number; leftover: number; issues: AdditiveImportIssue[] } {
  const issues: AdditiveImportIssue[] = [];
  // Filas indexadas: (1) por item+code  (2) por code normalizado
  const queueByItemCode = new Map<string, AnalyticBlock[]>();
  const queueByCode = new Map<string, AnalyticBlock[]>();
  const consumed = new Set<AnalyticBlock>();
  for (const b of blocks) {
    const itemKey = `${(b.item || '').trim()}|${b.normCode}`;
    if (!queueByItemCode.has(itemKey)) queueByItemCode.set(itemKey, []);
    queueByItemCode.get(itemKey)!.push(b);
    const cKey = b.normCode;
    if (!queueByCode.has(cKey)) queueByCode.set(cKey, []);
    queueByCode.get(cKey)!.push(b);
  }
  let linked = 0;

  const takeBlock = (item: string, code: string): AnalyticBlock | undefined => {
    const itemKey = `${(item || '').trim()}|${normalizeCode(code)}`;
    const qIc = queueByItemCode.get(itemKey);
    if (qIc) {
      while (qIc.length > 0) {
        const b = qIc.shift()!;
        if (!consumed.has(b)) { consumed.add(b); return b; }
      }
    }
    const qC = queueByCode.get(normalizeCode(code));
    if (qC) {
      while (qC.length > 0) {
        const b = qC.shift()!;
        if (!consumed.has(b)) { consumed.add(b); return b; }
      }
    }
    return undefined;
  };

  // Vincula composições SEM inputs (inclui novos serviços manuais com isNewService).
  const compositions = additive.compositions.map(c => {
    if (c.inputs && c.inputs.length > 0) return c; // já vinculado, preserva
    const block = takeBlock(c.item ?? '', c.code);
    if (!block) return c;
    linked++;
    const inputs: AdditiveInput[] = block.inputs.map(r => ({
      id: uid(),
      code: r.code,
      bank: r.bank,
      description: r.description,
      unit: r.unit,
      coefficient: r.coefficient,
      unitPrice: r.unitPrice,
      total: r.total || +(r.coefficient * r.unitPrice).toFixed(2),
    }));
    // Preserva todos os campos da composição (id, item, code, bank, description, unit,
    // quantity, addedQuantity, phaseId, phaseChain, itemNumber, isNewService, etc.).
    const merged: AdditiveComposition = { ...c, inputs };
    if (block.analyticUnitPriceWithBDI != null) {
      merged.analyticUnitPriceWithBDI = money2(block.analyticUnitPriceWithBDI);
      const q = money2(c.quantity ?? 0);
      merged.analyticTotalWithBDI = truncar2(money2(block.analyticUnitPriceWithBDI) * q);
    }
    return merged;
  });
  const leftover = blocks.filter(b => !consumed.has(b)).length;
  if (leftover > 0) {
    issues.push({ level: 'warning', message: `${leftover} bloco(s) analítico(s) sem composição correspondente foram ignorados.` });
  }
  return {
    additive: { ...additive, compositions, issues: [...(additive.issues ?? []), ...issues] },
    linked,
    leftover,
    issues,
  };
}

/**
 * Importação principal — aceita 3 cenários:
 *  • arquivo único Sintética + Analítica
 *  • somente Sintética
 *  • somente Analítica (precisa de aditivo existente para merge)
 */
export async function importAdditiveFromExcel(
  file: File,
  additiveName: string,
  existingAdditive?: Additive | null,
): Promise<AdditiveImportResult> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });

  let synthName = findSheetName(wb.SheetNames, 'Sintetica') || findSheetName(wb.SheetNames, 'sintética');
  let analyName = findSheetName(wb.SheetNames, 'Analitica') || findSheetName(wb.SheetNames, 'analítica');

  // Fallback por conteúdo: se não há aba ANALITICA pelo nome, procura por cabeçalhos compatíveis
  // em qualquer aba (exceto a Sintética). Aceita arquivos como "Folha 1" / "Planilha1".
  if (!analyName) {
    for (const name of wb.SheetNames) {
      if (synthName && name === synthName) continue;
      const rows = sheetToRows(wb.Sheets[name], XLSX);
      if (looksLikeAnalyticSheet(rows)) {
        analyName = name;
        break;
      }
    }
  }
  // Fallback por conteúdo para Sintética: cabeçalho com "Total" ou "BDI" em A..J.
  // (Mantemos detecção apenas por nome; conteúdo via looksLikeAnalyticSheet não deve confundir
  // pois a Sintética foi descartada acima.)
  const hasSynthetic = !!synthName;
  const hasAnalytic = !!analyName;

  // Caso 1 — somente Analítica
  if (!hasSynthetic && hasAnalytic) {
    const analyRows = sheetToRows(wb.Sheets[analyName!], XLSX);
    const { blocks, issues } = parseAdditiveAnalyticWorkbook(analyRows);

    if (existingAdditive) {
      const merged = mergeAnalyticIntoAdditive(existingAdditive, blocks);
      const infoIssues: AdditiveImportIssue[] = [
        { level: 'info', message: `Analítica vinculada ao aditivo "${existingAdditive.name}"` },
        { level: 'info', message: `Composições vinculadas: ${merged.linked}` },
        { level: 'info', message: `Insumos analíticos lidos: ${blocks.reduce((a, b) => a + b.inputs.length, 0)}` },
      ];
      return {
        additive: { ...merged.additive, issues: [...infoIssues, ...issues, ...(merged.additive.issues ?? [])] },
        mode: 'analytic_only',
        hasSynthetic: false,
        hasAnalytic: true,
        message: `Analítica vinculada: ${merged.linked} composições atualizadas.`,
      };
    }

    // Sem aditivo existente — devolve "pendente"
    const pendingAdditive: Additive = {
      id: uid(),
      name: additiveName,
      importedAt: new Date().toISOString(),
      compositions: [],
      issues: [
        { level: 'warning', message: 'Importe a Sintética primeiro para vincular os insumos analíticos.' },
        { level: 'info', message: `Blocos analíticos lidos (aguardando vínculo): ${blocks.length}` },
        ...issues,
      ],
      status: 'rascunho',
    };
    return {
      additive: pendingAdditive,
      mode: 'analytic_only',
      pendingAnalyticBlocks: blocks,
      hasSynthetic: false,
      hasAnalytic: true,
      message: 'Analítica importada, aguardando Sintética para vincular.',
    };
  }

  // Caso 2 — somente Sintética
  if (hasSynthetic && !hasAnalytic) {
    const synthRows = sheetToRows(wb.Sheets[synthName!], XLSX);
    const { additive, issues } = parseAdditiveSyntheticWorkbook(synthRows, additiveName);
    additive.issues = [
      { level: 'info', message: `Total de composições importadas: ${additive.compositions.length}` },
      { level: 'info', message: `BDI lido da planilha (J8): ${additive.bdiPercent ? additive.bdiPercent.toFixed(2) + '%' : 'não encontrado'}` },
      { level: 'warning', message: 'Aba Analítica não encontrada — composições ficarão sem insumos até importar a Analítica.' },
      ...issues,
    ];
    return {
      additive,
      mode: 'synthetic_only',
      hasSynthetic: true,
      hasAnalytic: false,
      message: 'Sintética importada. Analítica ainda não vinculada.',
    };
  }

  // Caso 3 — ambos
  if (hasSynthetic && hasAnalytic) {
    const synthRows = sheetToRows(wb.Sheets[synthName!], XLSX);
    const analyRows = sheetToRows(wb.Sheets[analyName!], XLSX);
    const { additive, issues: synthIssues } = parseAdditiveSyntheticWorkbook(synthRows, additiveName);
    const { blocks, issues: analyIssues } = parseAdditiveAnalyticWorkbook(analyRows);
    const merged = mergeAnalyticIntoAdditive(additive, blocks);

    const semAnalitico = merged.additive.compositions.filter(c => c.inputs.length === 0);
    const extraIssues: AdditiveImportIssue[] = semAnalitico.map(c => ({
      level: 'warning' as const,
      message: `Composição sintética sem analítico vinculado (${c.code})`,
      code: c.code,
    }));

    const totalInputs = merged.additive.compositions.reduce((a, c) => a + c.inputs.length, 0);
    const infoIssues: AdditiveImportIssue[] = [
      { level: 'info', message: `Total de composições importadas: ${merged.additive.compositions.length}` },
      { level: 'info', message: `Total de insumos importados: ${totalInputs}` },
      { level: 'info', message: `BDI lido da planilha (J8): ${merged.additive.bdiPercent ? merged.additive.bdiPercent.toFixed(2) + '%' : 'não encontrado'}` },
    ];
    return {
      additive: {
        ...merged.additive,
        issues: [...infoIssues, ...synthIssues, ...analyIssues, ...extraIssues, ...(merged.additive.issues ?? [])],
      },
      mode: 'both',
      hasSynthetic: true,
      hasAnalytic: true,
      message: `Aditivo importado com Sintética (${merged.additive.compositions.length}) e Analítica (${totalInputs} insumos).`,
    };
  }

  // Nenhuma das abas reconhecidas
  return {
    additive: {
      id: uid(),
      name: additiveName,
      importedAt: new Date().toISOString(),
      compositions: [],
      issues: [{ level: 'error', message: 'Nenhuma aba reconhecida (esperado SINTETICA e/ou ANALITICA).' }],
      status: 'rascunho',
    },
    mode: 'synthetic_only',
    hasSynthetic: false,
    hasAnalytic: false,
    message: 'Nenhuma aba SINTETICA ou ANALITICA encontrada na planilha.',
  };
}

/** Soma dos totais H dos insumos da Analítica (sem BDI), por unidade da composição. */
export function sumAnalyticTotalNoBDI(comp: AdditiveComposition): number {
  return comp.inputs.reduce((a, i) => a + (i.total || 0), 0);
}

/**
 * Quantidade efetiva da composição para fins de impacto financeiro do aditivo.
 * Definida pelas quantidades preenchidas: addedQuantity − suppressedQuantity.
 * Se ambas forem 0, o impacto é 0 (item sem alteração).
 * Para compatibilidade com aditivos antigos que só preenchiam quantity/changeKind,
 * mantém-se o fallback baseado em changeKind.
 */
export function effectiveQuantity(c: AdditiveComposition): number {
  const hasNewFields =
    c.addedQuantity != null || c.suppressedQuantity != null || c.originalQuantity != null;
  if (hasNewFields) {
    const add = c.addedQuantity ?? 0;
    const sup = c.suppressedQuantity ?? 0;
    return add - sup;
  }
  if (c.changeKind === 'suprimido') return -(c.quantity ?? 0);
  if (c.changeKind === 'sem_alteracao') return 0;
  return c.quantity ?? 0;
}

/** Quantidade total após o aditivo (originalQuantity + addedQuantity − suppressedQuantity). */
export function totalAfterAdditive(c: AdditiveComposition): number {
  const orig = c.originalQuantity ?? 0;
  const add = c.addedQuantity ?? 0;
  const sup = c.suppressedQuantity ?? 0;
  return orig + add - sup;
}

/**
 * Recalcula valores da composição com base no BDI atual (editável).
 * Usa a quantidade efetiva (acréscimo/supressão) para o impacto financeiro.
 */
export function computeCompositionWithBDI(comp: AdditiveComposition, bdiPercent: number) {
  const fator = 1 + (bdiPercent || 0) / 100;
  // Preserva valores importados quando existirem (Sintética da Medição/Excel).
  const unitPriceNoBDI = money2(comp.unitPriceNoBDI);
  const unitPriceWithBDI = money2(comp.unitPriceWithBDI ?? truncar2(unitPriceNoBDI * fator));
  const qty = money2(comp.quantity ?? 0);
  const totalSyntheticWithBDI =
    comp.totalWithBDI != null
      ? money2(comp.totalWithBDI)
      : money2(comp.total ?? truncar2(unitPriceWithBDI * qty));
  const sumAnalyticNoBDI = sumAnalyticTotalNoBDI(comp);
  // Valor unitário analítico c/ BDI: prioriza o lido da linha "Valor com BDI =" da planilha.
  // Caso contrário, trunca em 2 casas o produto (soma analítica s/ BDI × fator BDI), por unidade.
  const analyticUnitWithBDI = comp.analyticUnitPriceWithBDI != null
    ? money2(comp.analyticUnitPriceWithBDI)
    : truncar2(sumAnalyticNoBDI * fator);
  // Total analítico c/ BDI = TRUNC(unit c/ BDI × quantidade, 2) — segue o Excel.
  const totalAnalyticWithBDI = truncar2(analyticUnitWithBDI * qty);
  const diff = truncar2(totalAnalyticWithBDI - totalSyntheticWithBDI);
  // Impacto financeiro = (added − suppressed) × preço unitário.
  const effQty = money2(effectiveQuantity(comp));
  const impactoSemBDI = truncar2(unitPriceNoBDI * effQty);
  const impactoComBDI = truncar2(unitPriceWithBDI * effQty);
  return {
    unitPriceWithBDI, totalSyntheticWithBDI, sumAnalyticNoBDI,
    analyticUnitWithBDI, totalAnalyticWithBDI, diff,
    impactoSemBDI, impactoComBDI,
  };
}

/**
 * Calcula os valores por linha conforme o modelo Excel "Aditivo e Supressao":
 *   Qtd Final = Qtd Contratada − Qtd Suprimida + Qtd Acrescida
 *   Valor Contratado Calc. = Qtd Contratada × Valor Unit c/ BDI
 *   Valor Suprimido       = Qtd Suprimida × Valor Unit c/ BDI
 *   Valor Acrescido       = Qtd Acrescida × Valor Unit c/ BDI
 *   Valor Final           = Qtd Final × Valor Unit c/ BDI
 *   Diferença             = Valor Final − Valor Contratado Calc.
 *   % Var.                = Diferença / Valor Contratado Calc.
 */
/**
 * Retorna o valor unitário s/ BDI de REFERÊNCIA para um novo serviço.
 * Prioridade: soma da analítica (banco de preços, p.ex. SINAPI) → valor informado manualmente.
 */
export function referenceUnitNoBDIForNewService(comp: AdditiveComposition): number {
  const sumAnalytic = sumAnalyticTotalNoBDI(comp);
  if (sumAnalytic > 0) return money2(sumAnalytic);
  return money2(comp.unitPriceNoBDIInformed ?? comp.unitPriceNoBDI ?? 0);
}

export function computeAdditiveRow(comp: AdditiveComposition, bdiPercent: number, globalDiscountPercent = 0) {
  const fator = 1 + (bdiPercent || 0) / 100;
  const isNew = !!comp.isNewService;
  // Para novos serviços: o valor unitário s/ BDI exibido é a REFERÊNCIA (SINAPI), sem desconto.
  // O desconto global da licitação é aplicado em uma coluna separada e propaga para o BDI.
  const discountFactor = isNew ? (1 - (globalDiscountPercent || 0) / 100) : 1;
  const referenceUnitNoBDI = isNew
    ? referenceUnitNoBDIForNewService(comp)
    : money2(comp.unitPriceNoBDI);
  // Valor unitário s/ BDI exibido na coluna principal:
  //  - novos serviços: REFERÊNCIA SINAPI (sem desconto), para rastreabilidade;
  //  - existentes: valor importado da Sintética/Medição.
  const unitPriceNoBDI = referenceUnitNoBDI;
  // Valor com desconto licitatório (somente novos serviços; nos demais é igual à referência).
  const unitPriceNoBDIWithDiscount = isNew
    ? truncar2(referenceUnitNoBDI * discountFactor)
    : referenceUnitNoBDI;
  // Valor c/ BDI: aplicado SOBRE o valor já com desconto (novos) ou sobre o contratado (existentes).
  const unitPriceWithBDI = isNew
    ? truncar2(unitPriceNoBDIWithDiscount * fator)
    : money2(comp.unitPriceWithBDI ?? truncar2(unitPriceNoBDI * fator));
  const qtdContratada = comp.originalQuantity ?? comp.quantity ?? 0;
  const qtdSuprimida = comp.suppressedQuantity ?? 0;
  const qtdAcrescida = comp.addedQuantity ?? 0;
  const qtdFinal = qtdContratada - qtdSuprimida + qtdAcrescida;
  // Total Fonte preserva o valor original da Sintética/Medição (não recalcula). Para novos serviços é 0.
  const totalFonte = isNew
    ? 0
    : (comp.totalWithBDI != null
        ? money2(comp.totalWithBDI)
        : money2(comp.total ?? truncar2(unitPriceWithBDI * (comp.quantity ?? qtdContratada))));
  // Valor contratado original PRESERVADO (fonte). Para novos serviços = 0 (não havia contrato original).
  const valorContratadoOriginalPreservado = isNew
    ? 0
    : (comp.totalWithBDI != null
        ? money2(comp.totalWithBDI)
        : comp.total != null
          ? money2(comp.total)
          : money2(unitPriceWithBDI * qtdContratada));
  const valorContratadoCalc = truncar2(unitPriceWithBDI * qtdContratada);
  const valorSuprimido = truncar2(unitPriceWithBDI * qtdSuprimida);
  const valorAcrescido = truncar2(unitPriceWithBDI * qtdAcrescida);
  // Valor final preservando a fonte: original + acrescido − suprimido.
  const valorFinal = truncar2(valorContratadoOriginalPreservado + valorAcrescido - valorSuprimido);
  const diferenca = truncar2(valorFinal - valorContratadoOriginalPreservado);
  const percentVar = valorContratadoOriginalPreservado > 0 ? diferenca / valorContratadoOriginalPreservado : 0;
  return {
    unitPriceNoBDI, unitPriceNoBDIWithDiscount, unitPriceWithBDI,
    referenceUnitNoBDI, discountFactor, globalDiscountPercent: globalDiscountPercent || 0,
    qtdContratada, qtdSuprimida, qtdAcrescida, qtdFinal,
    totalFonte, valorContratadoCalc, valorContratadoOriginalPreservado,
    valorSuprimido, valorAcrescido, valorFinal,
    diferenca, percentVar,
    isNewService: isNew,
  };
}

/**
 * Total contratado oficial = soma de project.budgetItems com source==='sintetica',
 * usando totalWithBDI normalizado em 2 casas (mesmo critério da aba Medição).
 * Retorna `null` se não houver Sintética importada — nesse caso o chamador deve
 * usar o fallback (reconstrução pelas linhas do Aditivo).
 */
export function getOfficialContractedTotal(project: Project | null | undefined): number | null {
  const items = project?.budgetItems?.filter(b => b.source === 'sintetica') ?? [];
  if (items.length === 0) return null;
  let acc = 0;
  for (const it of items) acc += Number(it.totalWithBDI) || 0;
  return _money2(acc);
}

export function additiveTotals(add: Additive, project?: Project | null) {
  const bdi = add.bdiPercent ?? 0;
  const discount = add.globalDiscountPercent ?? 0;
  const compCount = add.compositions.length;
  const totalSemBDI = add.compositions.reduce(
    (a, c) => truncar2(a + money2(c.totalNoBDI ?? c.unitPriceNoBDI * c.quantity)),
    0,
  );
  const totalComBDI = add.compositions.reduce((a, c) => {
    const { totalSyntheticWithBDI } = computeCompositionWithBDI(c, bdi);
    return truncar2(a + totalSyntheticWithBDI);
  }, 0);
  // Impacto líquido (acrescido positivo, suprimido negativo)
  const impactoSemBDI = add.compositions.reduce((a, c) => truncar2(a + computeCompositionWithBDI(c, bdi).impactoSemBDI), 0);
  const impactoComBDI = add.compositions.reduce((a, c) => truncar2(a + computeCompositionWithBDI(c, bdi).impactoComBDI), 0);
  const inputCount = add.compositions.reduce((a, c) => a + c.inputs.length, 0);
  const semAnalitico = add.compositions.filter(c => c.inputs.length === 0).length;
  const acrescidos = add.compositions.filter(c => (c.addedQuantity ?? 0) > 0).length;
  const suprimidos = add.compositions.filter(c => (c.suppressedQuantity ?? 0) > 0).length;

  // Bloco TOTAL GERAL (modelo Excel)
  let totalContratadoOriginal = 0;
  let totalSuprimido = 0;
  let totalAcrescido = 0;
  let totalAcrescidoExistentes = 0;
  let totalNovosServicos = 0;
  let valorFinal = 0;
  for (const c of add.compositions) {
    const r = computeAdditiveRow(c, bdi, discount);
    totalContratadoOriginal = truncar2(totalContratadoOriginal + r.valorContratadoOriginalPreservado);
    totalSuprimido = truncar2(totalSuprimido + r.valorSuprimido);
    totalAcrescido = truncar2(totalAcrescido + r.valorAcrescido);
    if (r.isNewService) {
      totalNovosServicos = truncar2(totalNovosServicos + r.valorAcrescido);
    } else {
      totalAcrescidoExistentes = truncar2(totalAcrescidoExistentes + r.valorAcrescido);
    }
    valorFinal = truncar2(valorFinal + r.valorFinal);
  }
  // Total contratado oficial: prioriza a Sintética/Medição (project.budgetItems source==='sintetica').
  // Só cai no fallback (reconstrução por linhas) se não houver Sintética importada.
  const officialContracted = getOfficialContractedTotal(project ?? null);
  if (officialContracted != null) {
    totalContratadoOriginal = officialContracted;
  }
  // Recalcula valorFinal a partir do total oficial: oficial - suprimido + acrescido
  valorFinal = truncar2(totalContratadoOriginal - totalSuprimido + totalAcrescido);
  const diferencaLiquida = truncar2(valorFinal - totalContratadoOriginal);
  const percentVariacaoLiquida = totalContratadoOriginal > 0 ? diferencaLiquida / totalContratadoOriginal : 0;
  const percentSupressao = totalContratadoOriginal > 0 ? totalSuprimido / totalContratadoOriginal : 0;
  const percentAcrescimo = totalContratadoOriginal > 0 ? totalAcrescido / totalContratadoOriginal : 0;
  const percentImpactoLiquido = percentVariacaoLiquida;

  const limitPercent = (add.aditivoLimitPercent ?? 50) / 100;
  const limitStatus: 'ok' | 'revisar' =
    Math.abs(percentImpactoLiquido) <= limitPercent ? 'ok' : 'revisar';

  return {
    compCount, totalSemBDI, totalComBDI, total: totalComBDI,
    inputCount, semAnalitico, acrescidos, suprimidos,
    impactoSemBDI, impactoComBDI,
    // Bloco TOTAL GERAL
    totalContratadoOriginal, totalSuprimido, totalAcrescido, valorFinal,
    totalAcrescidoExistentes, totalNovosServicos,
    diferencaLiquida, percentVariacaoLiquida,
    percentSupressao, percentAcrescimo, percentImpactoLiquido,
    limitPercent, limitStatus,
    /** True quando o total veio da Sintética/Medição (oficial) e não da reconstrução. */
    contractedSource: (officialContracted != null ? 'sintetica' : 'fallback') as 'sintetica' | 'fallback',
  };
}

// ============= Integração com o Projeto =============

export interface ApprovedAdditiveItem {
  additiveId: string;
  additiveName: string;
  compositionId: string;
  item: string;
  code: string;
  bank: string;
  description: string;
  unit: string;
  changeKind: AdditiveChangeKind;
  originalQuantity: number;
  suppressedQuantity: number;
  addedQuantity: number;
  totalAfter: number;
  unitPriceNoBDI: number;
  unitPriceWithBDI: number;
  status: 'aprovado';
  approvedAt?: string;
  approvedBy?: string;
}

/** Retorna itens dos aditivos APROVADOS, prontos para integrar com Medição/Tarefas/Diário. */
export function getApprovedAdditiveItems(project: Project): ApprovedAdditiveItem[] {
  const out: ApprovedAdditiveItem[] = [];
  const adds = project.additives ?? [];
  for (const a of adds) {
    if (a.status !== 'aprovado') continue;
    const bdi = a.bdiPercent ?? 0;
    const fator = 1 + bdi / 100;
    for (const c of a.compositions) {
      const upWithBDI = truncar2(c.unitPriceNoBDI * fator);
      out.push({
        additiveId: a.id,
        additiveName: a.name,
        compositionId: c.id,
        item: c.item,
        code: c.code,
        bank: c.bank,
        description: c.description,
        unit: c.unit,
        changeKind: c.changeKind ?? 'acrescido',
        originalQuantity: c.originalQuantity ?? 0,
        suppressedQuantity: c.suppressedQuantity ?? 0,
        addedQuantity: c.addedQuantity ?? c.quantity ?? 0,
        totalAfter: totalAfterAdditive(c),
        unitPriceNoBDI: c.unitPriceNoBDI,
        unitPriceWithBDI: upWithBDI,
        status: 'aprovado',
        approvedAt: a.approvedAt,
        approvedBy: a.approvedBy,
      });
    }
  }
  return out;
}

/**
 * Converte composições de aditivos APROVADOS em BudgetItems prontos para a Medição.
 * - acrescido  → quantity = +addedQuantity (ou quantity)
 * - suprimido  → quantity = -suppressedQuantity (impacto negativo)
 * - sem_alteracao → ignorado
 */
export function getApprovedAdditiveBudgetItems(project: Project): BudgetItem[] {
  const out: BudgetItem[] = [];
  for (const a of project.additives ?? []) {
    if (a.status !== 'aprovado' && a.status !== 'aditivo_contratado' && !a.isContracted) continue;
    const bdi = a.bdiPercent ?? 0;
    const discount = a.globalDiscountPercent ?? 0;
    const fator = 1 + bdi / 100;
    for (const c of a.compositions) {
      // Novos serviços só entram na Medição quando o aditivo foi contratado.
      if (c.isNewService && !a.isContracted) continue;
      const kind = c.changeKind ?? 'acrescido';
      if (kind === 'sem_alteracao' && !c.isNewService) continue;
      const qty = c.isNewService
        ? (c.addedQuantity ?? c.quantity ?? 0)
        : kind === 'suprimido'
          ? -(c.suppressedQuantity ?? c.quantity ?? 0)
          : (c.addedQuantity ?? c.quantity ?? 0);
      if (!qty) continue;
      // Para novos serviços, usa REFERÊNCIA da analítica (SINAPI) e aplica desconto global da licitação.
      const baseUnitNoBDI = c.isNewService
        ? money2(referenceUnitNoBDIForNewService(c) * (1 - discount / 100))
        : (c.unitPriceNoBDI || 0);
      const upWithBDI = c.isNewService
        ? truncar2(baseUnitNoBDI * fator)
        : (c.unitPriceWithBDI || truncar2(baseUnitNoBDI * fator));
      out.push({
        id: `add-${a.id}-${c.id}`,
        item: c.item,
        code: c.code,
        bank: c.bank,
        description: c.description,
        unit: c.unit,
        quantity: qty,
        unitPriceNoBDI: baseUnitNoBDI,
        unitPriceWithBDI: upWithBDI,
        totalNoBDI: truncar2(baseUnitNoBDI * qty),
        totalWithBDI: truncar2(upWithBDI * qty),
        source: 'aditivo',
        additiveId: a.id,
      });
    }
  }
  return out;
}

/**
 * Constrói um Additive em rascunho a partir dos BudgetItems Sintéticos já importados
 * em project.budgetItems (alimentados pela aba Tarefas/Medição).
 *
 * Cada composição recebe o vínculo com a EAP (phaseId, phaseChain, taskId, itemNumber)
 * usando a mesma lógica de matching da Medição (taskId → código → item → descrição,
 * com filas para evitar reuso de itens repetidos).
 */
export function buildAdditiveFromSyntheticBudgetItems(
  project: Project,
  name = 'Aditivo (Sintética da Medição)',
): Additive | null {
  const items = (project.budgetItems ?? []).filter(b => b.source === 'sintetica');
  if (items.length === 0) return null;
  const bdi = project.syntheticBdiPercent ?? project.contractInfo?.bdiPercent ?? 0;
  const issues: AdditiveImportIssue[] = [
    { level: 'info', message: `Sintética reaproveitada da Medição: ${items.length} composições.` },
    { level: 'warning', message: 'Sem Analítica vinculada — importe a Analítica do aditivo para preencher os insumos.' },
  ];

  // ── Construção da lista ordenada de tarefas (mesma lógica da Medição) ──
  const numbering = getChapterNumbering(project);
  const tree = getChapterTree(project);
  type OrderedTask = { task: Task; phase: Phase; itemNumber: string; chain: string };
  const orderedTasks: OrderedTask[] = [];
  const walk = (nodes: ChapterNode[], chain: string[]) => {
    nodes.forEach(node => {
      const phaseNumber = numbering.get(node.phase.id) || '';
      const newChain = [...chain, node.phase.name];
      node.phase.tasks.forEach((task, idx) => {
        orderedTasks.push({
          task, phase: node.phase,
          itemNumber: `${phaseNumber}.${idx + 1}`,
          chain: newChain.join(' › '),
        });
      });
      walk(node.children, newChain);
    });
  };
  walk(tree, []);
  const visited = new Set(orderedTasks.map(o => o.phase.id));
  project.phases.forEach(phase => {
    if (visited.has(phase.id)) return;
    const phaseNumber = numbering.get(phase.id) || '?';
    phase.tasks.forEach((task, idx) => {
      orderedTasks.push({
        task, phase,
        itemNumber: `${phaseNumber}.${idx + 1}`,
        chain: phase.name,
      });
    });
  });

  // ── Matching: filas por chave para consumo único ──
  const normCodeKey = (s: string | undefined | null): string => {
    if (!s) return '';
    let v = String(s).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return v.replace(/\s+/g, ' ');
  };
  const normNumeric = (s: string | undefined | null): string => {
    const v = normCodeKey(s);
    return v.split('.').map(seg => /^\d+$/.test(seg) ? String(parseInt(seg, 10)) : seg).join('.');
  };
  const normDesc = (s: string | undefined | null): string => normCodeKey(s).replace(/[^A-Z0-9 ]/g, '');

  const queueByCode = new Map<string, BudgetItem[]>();
  const queueByItem = new Map<string, BudgetItem[]>();
  const queueByDesc = new Map<string, BudgetItem[]>();
  const consumed = new Set<string>();

  items.forEach(b => {
    const cKey = normCodeKey(b.code);
    if (cKey) {
      const arr = queueByCode.get(cKey) || [];
      arr.push(b); queueByCode.set(cKey, arr);
    }
    const iKey = normNumeric(b.item);
    if (iKey) {
      const arr = queueByItem.get(iKey) || [];
      arr.push(b); queueByItem.set(iKey, arr);
    }
    const dKey = normDesc(b.description);
    if (dKey) {
      const arr = queueByDesc.get(dKey) || [];
      arr.push(b); queueByDesc.set(dKey, arr);
    }
  });

  const popFromQueue = (q: BudgetItem[] | undefined): BudgetItem | undefined => {
    if (!q) return undefined;
    while (q.length > 0) {
      const candidate = q.shift()!;
      if (!consumed.has(candidate.id)) {
        consumed.add(candidate.id);
        return candidate;
      }
    }
    return undefined;
  };

  // Mapa: budgetItem.id → vínculo EAP encontrado (phaseId, chain, taskId, itemNumber)
  const linkByBudgetId = new Map<string, { phaseId: string; phaseChain: string; taskId: string; itemNumber: string }>();

  for (const ot of orderedTasks) {
    let matched: BudgetItem | undefined;
    // 1) taskId direto
    matched = items.find(b => b.taskId === ot.task.id && !consumed.has(b.id));
    if (matched) consumed.add(matched.id);
    // 2) código normalizado
    if (!matched) {
      const k = normCodeKey(ot.task.itemCode);
      if (k) matched = popFromQueue(queueByCode.get(k));
    }
    // 3) descrição normalizada (fallback)
    if (!matched) {
      const k = normDesc(ot.task.name);
      if (k) matched = popFromQueue(queueByDesc.get(k));
    }
    if (matched) {
      linkByBudgetId.set(matched.id, {
        phaseId: ot.phase.id,
        phaseChain: ot.chain,
        taskId: ot.task.id,
        itemNumber: ot.itemNumber,
      });
    }
  }

  const compositions: AdditiveComposition[] = items.map(b => {
    // Preserva EXATAMENTE os valores já normalizados na Medição — não recalcula com BDI.
    const upNoBDI = money2(b.unitPriceNoBDI);
    const upWithBDI = money2(b.unitPriceWithBDI);
    const hasTotalNoBDI = b.totalNoBDI !== null && b.totalNoBDI !== undefined;
    const hasTotalWithBDI = b.totalWithBDI !== null && b.totalWithBDI !== undefined;
    const tNoBDI = hasTotalNoBDI ? money2(b.totalNoBDI) : money2(truncar2(upNoBDI * b.quantity));
    const tWithBDI = hasTotalWithBDI ? money2(b.totalWithBDI) : money2(truncar2(upWithBDI * b.quantity));
    if (!hasTotalNoBDI || !hasTotalWithBDI) {
      issues.push({
        level: 'warning',
        message: `Totais ausentes na Sintética da Medição (${b.code || b.description}); fallback calculado proporcionalmente.`,
        code: b.code,
      });
    }
    const link = linkByBudgetId.get(b.id);
    return {
      id: uid(),
      item: b.item,
      code: b.code,
      bank: b.bank,
      description: b.description,
      quantity: b.quantity,
      unit: b.unit,
      unitPriceNoBDI: upNoBDI,
      unitPriceWithBDI: upWithBDI,
      total: tWithBDI,
      totalNoBDI: tNoBDI,
      totalWithBDI: tWithBDI,
      inputs: [],
      source: 'sintetica_medicao',
      changeKind: 'sem_alteracao',
      originalQuantity: b.quantity,
      addedQuantity: 0,
      suppressedQuantity: 0,
      phaseId: link?.phaseId,
      phaseChain: link?.phaseChain,
      taskId: link?.taskId,
      itemNumber: link?.itemNumber,
    };
  });

  const linkedCount = compositions.filter(c => c.phaseId).length;
  const orphanCount = compositions.length - linkedCount;
  issues.push({
    level: 'info',
    message: `Vínculo com a EAP: ${linkedCount} composições associadas a tarefas; ${orphanCount} sem vínculo.`,
  });

  return {
    id: uid(),
    name,
    importedAt: new Date().toISOString(),
    compositions,
    issues,
    bdiPercent: bdi,
    status: 'rascunho',
  };
}

// ============= Exportações =============

/* ---------- Helpers internos para exportadores ---------- */

const FMT_BRL = 'R$ #,##0.00;[Red](R$ #,##0.00);-';
const FMT_QTD = '#,##0.00';
const FMT_PCT = '0.00%';

function safeFileName(name: string): string {
  return (name || 'aditivo').replace(/[^\w\d\-]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Aplica número + format a uma célula já escrita pelo aoa_to_sheet. */
function applyNumberFormat(ws: any, ref: string, fmt: string) {
  const cell = ws[ref];
  if (cell && cell.t !== 's') cell.z = fmt;
}

/** Aplica formato a uma faixa (ex: aplicar BRL nas colunas K..R a partir da linha N). */
function applyColumnFormats(
  ws: any,
  startRow: number, // 1-based
  endRow: number,   // 1-based inclusive
  formatsByCol: Record<number, string>, // col index 0-based -> format
) {
  const XLSX = (globalThis as any).__xlsxRef;
  for (let r = startRow; r <= endRow; r++) {
    for (const colStr of Object.keys(formatsByCol)) {
      const c = Number(colStr);
      const ref = XLSX.utils.encode_cell({ r: r - 1, c });
      applyNumberFormat(ws, ref, formatsByCol[c]);
    }
  }
}

/**
 * Caminha pelas composições de um aditivo seguindo a ordem da EAP
 * (Capítulo > Subcapítulo > Composição), igual à visualização da aba Aditivo.
 *
 * Para cada capítulo emite onChapterStart/onChapterEnd.
 * Para cada composição emite onComposition.
 * Composições sem phaseId vão para o final em onOrphan (sem capítulo).
 */
interface ChapterWalkHandlers {
  onChapterStart?: (chapter: { id: string; number: string; name: string; depth: number }) => void;
  onChapterEnd?: (chapter: {
    id: string;
    number: string;
    name: string;
    depth: number;
    rows: AdditiveComposition[];
    descendants: AdditiveComposition[];
  }) => void;
  onComposition?: (
    comp: AdditiveComposition,
    chapter: { id: string; number: string; name: string; depth: number } | null,
  ) => void;
  onOrphanStart?: () => void;
}

function walkAdditiveByChapters(
  project: Project,
  add: Additive,
  filter: (c: AdditiveComposition) => boolean,
  handlers: ChapterWalkHandlers,
) {
  const byPhase = new Map<string, AdditiveComposition[]>();
  const orphans: AdditiveComposition[] = [];
  add.compositions.filter(filter).forEach(c => {
    if (c.phaseId) {
      const arr = byPhase.get(c.phaseId) ?? [];
      arr.push(c);
      byPhase.set(c.phaseId, arr);
    } else {
      orphans.push(c);
    }
  });

  const numbering = getChapterNumbering(project);
  const tree = getChapterTree(project);

  const walk = (node: ChapterNode, depth: number): AdditiveComposition[] => {
    const directRows = byPhase.get(node.phase.id) ?? [];
    // Visita filhos primeiro para saber se vale incluir o nó.
    const childDescendants: AdditiveComposition[] = [];
    const childResults = node.children.map(child => {
      const before = childDescendants.length;
      const res = walk(child, depth + 1);
      if (res.length > 0) childDescendants.push(...res);
      void before;
      return res;
    });
    void childResults;
    if (directRows.length === 0 && childDescendants.length === 0) return [];

    const chapterInfo = {
      id: node.phase.id,
      number: numbering.get(node.phase.id) || '',
      name: node.phase.name,
      depth,
    };
    handlers.onChapterStart?.(chapterInfo);
    directRows.forEach(c => handlers.onComposition?.(c, chapterInfo));
    // children já foram visitados acima — refazer para emitir na ordem correta.
    // Solução: refazer iteração apenas para emitir filhos preservando ordem.
    return [...directRows, ...childDescendants];
  };

  // Refazer o walk garantindo emissão em ordem de capítulo > composições > filhos.
  const emit = (node: ChapterNode, depth: number): AdditiveComposition[] => {
    const directRows = byPhase.get(node.phase.id) ?? [];
    const childResults: AdditiveComposition[][] = [];
    let descendantsTotal: AdditiveComposition[] = [];
    for (const child of node.children) {
      const acc: AdditiveComposition[] = [];
      const probe = (n: ChapterNode): AdditiveComposition[] => {
        const dr = byPhase.get(n.phase.id) ?? [];
        const sub: AdditiveComposition[] = [];
        n.children.forEach(c2 => sub.push(...probe(c2)));
        return [...dr, ...sub];
      };
      acc.push(...probe(child));
      childResults.push(acc);
      descendantsTotal.push(...acc);
    }
    if (directRows.length === 0 && descendantsTotal.length === 0) return [];

    const chapterInfo = {
      id: node.phase.id,
      number: numbering.get(node.phase.id) || '',
      name: node.phase.name,
      depth,
    };
    handlers.onChapterStart?.(chapterInfo);
    directRows.forEach(c => handlers.onComposition?.(c, chapterInfo));
    // Emite cada filho recursivamente (que por sua vez chama onChapterStart/onChapterEnd dele).
    node.children.forEach(child => emit(child, depth + 1));
    handlers.onChapterEnd?.({
      ...chapterInfo,
      rows: directRows,
      descendants: descendantsTotal,
    });
    return [...directRows, ...descendantsTotal];
  };

  // Eliminar variáveis intermediárias (walk não-emissor era apenas para conferência).
  void walk;

  tree.forEach(n => emit(n, 0));

  if (orphans.length > 0) {
    handlers.onOrphanStart?.();
    orphans.forEach(c => handlers.onComposition?.(c, null));
  }
}

/* ---------- Exportador 1: Sintética Completa ---------- */

export async function exportAdditiveSyntheticCompleteToExcel(
  project: Project,
  add: Additive,
) {
  const XLSX = await import('xlsx');
  (globalThis as any).__xlsxRef = XLSX;
  const bdi = add.bdiPercent ?? 0;
  const discount = add.globalDiscountPercent ?? 0;

  const header = [
    'Item', 'Código', 'Banco', 'Descrição', 'Unidade',
    'Qtd Contratada', 'Qtd Suprimida', 'Qtd Acrescida', 'Qtd Final',
    'Valor Unit s/ BDI', 'Valor Unit c/ BDI',
    'Total Fonte', 'Valor Contratado', 'Valor Suprimido', 'Valor Acrescido', 'Valor Final',
    'Diferença', '% Var.', 'Situação',
  ];
  const titleRows = [
    [`Aditivo: ${add.name} — Sintética Completa`],
    [`BDI: ${bdi.toFixed(2)}%   |   Desconto Licit.: ${discount.toFixed(2)}%   |   Status: ${add.status ?? 'rascunho'}`],
    [],
  ];
  const aoa: (string | number)[][] = [...titleRows, header];

  const numericColIdx: Record<number, string> = {
    5: FMT_QTD, 6: FMT_QTD, 7: FMT_QTD, 8: FMT_QTD,
    9: FMT_BRL, 10: FMT_BRL,
    11: FMT_BRL, 12: FMT_BRL, 13: FMT_BRL, 14: FMT_BRL, 15: FMT_BRL,
    16: FMT_BRL, 17: FMT_PCT,
  };

  const compRowRanges: Array<{ row: number }> = [];

  const pushComposition = (c: AdditiveComposition) => {
    const r = computeAdditiveRow(c, bdi, discount);
    let situacao = 'Sem alteração';
    if (c.isNewService) situacao = 'Novo serviço aditivado';
    else if ((c.suppressedQuantity ?? 0) > 0 || (c.addedQuantity ?? 0) > 0) {
      situacao = 'Item contratado alterado';
    }
    aoa.push([
      c.item, c.code, c.bank, c.description, c.unit,
      r.qtdContratada, r.qtdSuprimida, r.qtdAcrescida, r.qtdFinal,
      r.unitPriceNoBDI, r.unitPriceWithBDI,
      r.totalFonte, r.valorContratadoOriginalPreservado,
      r.valorSuprimido, r.valorAcrescido, r.valorFinal,
      r.diferenca, r.percentVar,
      situacao,
    ]);
    compRowRanges.push({ row: aoa.length });
  };

  const subtotalRows: number[] = [];

  walkAdditiveByChapters(project, add, () => true, {
    onChapterStart: ch => {
      const indent = '  '.repeat(ch.depth);
      aoa.push([`${indent}${ch.number} ${ch.name}`]);
    },
    onComposition: c => pushComposition(c),
    onChapterEnd: ch => {
      // Subtotal recursivo (rows + descendentes diretos/indiretos)
      const all = [...ch.rows, ...ch.descendants.filter(d => !ch.rows.includes(d))];
      let sFonte = 0, sContr = 0, sSup = 0, sAcr = 0, sFinal = 0;
      all.forEach(c => {
        const r = computeAdditiveRow(c, bdi, discount);
        sFonte += r.totalFonte;
        sContr += r.valorContratadoOriginalPreservado;
        sSup += r.valorSuprimido;
        sAcr += r.valorAcrescido;
        sFinal += r.valorFinal;
      });
      const indent = '  '.repeat(ch.depth);
      aoa.push([
        `${indent}Subtotal ${ch.number} ${ch.name}`, '', '', '', '', '', '', '', '',
        '', '',
        money2(sFonte), money2(sContr), money2(sSup), money2(sAcr), money2(sFinal),
        money2(sFinal - sContr), '', '',
      ]);
      subtotalRows.push(aoa.length);
    },
    onOrphanStart: () => aoa.push(['Sem capítulo (não vinculado à EAP)']),
  });

  // TOTAL GERAL
  const totals = additiveTotals(add, project);
  aoa.push([]);
  aoa.push([
    'TOTAL GERAL', '', '', '', '', '', '', '', '',
    '', '',
    '', totals.totalContratadoOriginal, totals.totalSuprimido, totals.totalAcrescido, totals.valorFinal,
    totals.diferencaLiquida, totals.percentVariacaoLiquida, '',
  ]);
  const totalRow = aoa.length;

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 50 }, { wch: 8 },
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
    { wch: 16 }, { wch: 16 },
    { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 },
    { wch: 16 }, { wch: 10 }, { wch: 24 },
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: 4 };
  (ws as any)['!views'] = [{ state: 'frozen', ySplit: 4 }];

  // Aplicar formatos numéricos a todas as linhas (do header em diante).
  const lastRow = aoa.length;
  applyColumnFormats(ws, 5, lastRow, numericColIdx);
  // Subtotal/Total: formatar BRL/PCT
  [...subtotalRows, totalRow].forEach(r => {
    applyColumnFormats(ws, r, r, numericColIdx);
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sintética Completa');
  XLSX.writeFile(wb, `aditivo_sintetica_completa_${safeFileName(add.name)}.xlsx`);
}

/* ---------- Exportador 2: Novas Composições ---------- */

export async function exportAdditiveNewServicesToExcel(
  project: Project,
  add: Additive,
) {
  const XLSX = await import('xlsx');
  (globalThis as any).__xlsxRef = XLSX;
  const bdi = add.bdiPercent ?? 0;
  const discount = add.globalDiscountPercent ?? 0;

  const header = [
    'Item', 'Código', 'Banco', 'Descrição', 'Unidade',
    'Qtd Acrescida',
    'Valor Unit Referência s/ BDI', 'Desconto Licit. %', 'Valor Unit s/ BDI com Desconto',
    'BDI %', 'Valor Unit c/ BDI',
    'Valor Acrescido', 'Valor Final',
    'Fonte / Observação',
  ];
  const aoa: (string | number)[][] = [
    [`Aditivo: ${add.name} — Novas Composições`],
    [`BDI: ${bdi.toFixed(2)}%   |   Desconto Licit.: ${discount.toFixed(2)}%`],
    [],
    header,
  ];

  let totalAcrescido = 0;
  let totalFinal = 0;

  const numericFmt: Record<number, string> = {
    5: FMT_QTD, 6: FMT_BRL, 7: FMT_PCT, 8: FMT_BRL, 9: FMT_PCT,
    10: FMT_BRL, 11: FMT_BRL, 12: FMT_BRL,
  };

  walkAdditiveByChapters(project, add, c => !!c.isNewService, {
    onChapterStart: ch => {
      const indent = '  '.repeat(ch.depth);
      aoa.push([`${indent}${ch.number} ${ch.name}`]);
    },
    onComposition: c => {
      const r = computeAdditiveRow(c, bdi, discount);
      const refUnit = referenceUnitNoBDIForNewService(c);
      const obs = c.bank ? `Fonte: ${c.bank}` : 'Novo serviço aditivado';
      aoa.push([
        c.item, c.code, c.bank, c.description, c.unit,
        r.qtdAcrescida,
        refUnit,
        (discount || 0) / 100,
        r.unitPriceNoBDIWithDiscount,
        (bdi || 0) / 100,
        r.unitPriceWithBDI,
        r.valorAcrescido, r.valorFinal,
        obs,
      ]);
      totalAcrescido = money2(totalAcrescido + r.valorAcrescido);
      totalFinal = money2(totalFinal + r.valorFinal);
    },
    onOrphanStart: () => aoa.push(['Sem capítulo (não vinculado à EAP)']),
  });

  aoa.push([]);
  aoa.push([
    'TOTAL NOVAS COMPOSIÇÕES', '', '', '', '', '', '', '', '', '', '',
    totalAcrescido, totalFinal, '',
  ]);
  const totalRow = aoa.length;

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 50 }, { wch: 8 },
    { wch: 14 },
    { wch: 22 }, { wch: 14 }, { wch: 22 }, { wch: 10 }, { wch: 18 },
    { wch: 16 }, { wch: 16 }, { wch: 30 },
  ];
  (ws as any)['!views'] = [{ state: 'frozen', ySplit: 4 }];
  applyColumnFormats(ws, 5, aoa.length, numericFmt);
  applyColumnFormats(ws, totalRow, totalRow, numericFmt);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Novas Composições');
  XLSX.writeFile(wb, `aditivo_novas_composicoes_${safeFileName(add.name)}.xlsx`);
}

/* ---------- Exportador 3: Memória de Cálculo ---------- */

export async function exportAdditiveCalculationMemoryToExcel(
  project: Project,
  add: Additive,
) {
  const XLSX = await import('xlsx');
  (globalThis as any).__xlsxRef = XLSX;

  const aoa: (string | number)[][] = [
    [`Aditivo: ${add.name} — Memória de Cálculo`],
    [],
  ];

  const compHeader = [
    'Item', 'Código', 'Banco', 'Descrição', 'Unidade',
    'Qtd Contratada', 'Qtd Suprimida', 'Qtd Acrescida', 'Qtd Final',
  ];
  const memHeader = ['Loc', 'Tipo', 'Comentário', 'Fórmula', 'UND', 'Comprim.', 'Largura', 'Altura', 'Parcial'];

  const filterFn = (c: AdditiveComposition) => {
    const sup = c.suppressedQuantity ?? 0;
    const acr = c.addedQuantity ?? 0;
    const hasMem = validMemoryRows(c.calculationMemory).length > 0;
    return !!c.isNewService || sup > 0 || acr > 0 || hasMem;
  };

  let grandAcr = 0;
  let grandSup = 0;

  walkAdditiveByChapters(project, add, filterFn, {
    onChapterStart: ch => {
      const indent = '  '.repeat(ch.depth);
      aoa.push([`${indent}${ch.number} ${ch.name}`]);
    },
    onComposition: c => {
      const labels = resolveMemoryColumnLabels(c.calculationMemoryColumns);
      const localMemHeader = ['Loc', 'Tipo', 'Comentário', 'Fórmula', labels.a, labels.b, labels.c, labels.d, 'Parcial'];
      // Linha de identificação
      aoa.push(compHeader);
      aoa.push([
        c.item, c.code, c.bank, c.description, c.unit,
        c.originalQuantity ?? 0, c.suppressedQuantity ?? 0, c.addedQuantity ?? 0,
        totalAfterAdditive(c),
      ]);
      // Cabeçalho da memória
      aoa.push(localMemHeader);
      const rows = validMemoryRows(c.calculationMemory);
      if (rows.length === 0) {
        aoa.push(['—', '—', 'Sem memória de cálculo preenchida', '', '', '', '', '', '']);
      } else {
        let totAcr = 0;
        let totSup = 0;
        rows.forEach((m, idx) => {
          const partial = Number.isFinite(m.partial) ? m.partial : 0;
          aoa.push([
            idx + 1,
            m.type === 'suprimida' ? 'Suprimida' : 'Acrescida',
            m.comment ?? '', m.formula ?? '',
            m.a ?? '', m.b ?? '', m.c ?? '', m.d ?? '',
            partial,
          ]);
          if (m.type === 'suprimida') totSup += partial;
          else totAcr += partial;
        });
        aoa.push(['', '', 'Total Acrescida', '', '', '', '', '', money2(totAcr)]);
        aoa.push(['', '', 'Total Suprimida', '', '', '', '', '', money2(totSup)]);
        grandAcr = money2(grandAcr + totAcr);
        grandSup = money2(grandSup + totSup);
      }
      memHeader; // referência só
      aoa.push([]);
    },
    onOrphanStart: () => aoa.push(['Sem capítulo (não vinculado à EAP)']),
  });

  aoa.push([]);
  aoa.push(['TOTAL GERAL ACRESCIDO', '', '', '', '', '', '', '', money2(grandAcr)]);
  aoa.push(['TOTAL GERAL SUPRIMIDO', '', '', '', '', '', '', '', money2(grandSup)]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 50 }, { wch: 10 },
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
  ];
  (ws as any)['!views'] = [{ state: 'frozen', ySplit: 2 }];

  // Formatar coluna "Parcial" (índice 8) como número, demais qtds como número.
  for (let r = 1; r <= aoa.length; r++) {
    [5, 6, 7, 8].forEach(c => {
      const ref = XLSX.utils.encode_cell({ r: r - 1, c });
      applyNumberFormat(ws, ref, FMT_QTD);
    });
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Memória de Cálculo');
  XLSX.writeFile(wb, `aditivo_memoria_calculo_${safeFileName(add.name)}.xlsx`);
}

export async function exportAdditiveToExcel(add: Additive) {
  const XLSX = await import('xlsx');
  const bdi = add.bdiPercent ?? 0;
  const synthHeader = [
    'Item', 'Código', 'Banco', 'Discriminação', 'Und',
    'Quant. Contrat.', 'Itens Suprimidos', 'Itens Aditivados', 'Total após Troca',
    'V.Unit s/BDI', 'V.Unit c/BDI',
    'Impacto s/BDI', 'Impacto c/BDI',
    'Soma Analítica s/BDI', 'Total Analítico c/BDI', 'Diferença',
  ];
  const synthRows = add.compositions.map(c => {
    const r = computeCompositionWithBDI(c, bdi);
    return [
      c.item, c.code, c.bank, c.description, c.unit,
      c.originalQuantity ?? 0,
      c.suppressedQuantity ?? 0,
      c.addedQuantity ?? c.quantity,
      totalAfterAdditive(c),
      c.unitPriceNoBDI, r.unitPriceWithBDI,
      r.impactoSemBDI, r.impactoComBDI,
      r.sumAnalyticNoBDI, r.totalAnalyticWithBDI, r.diff,
    ];
  });
  const wsSynth = XLSX.utils.aoa_to_sheet([
    [`Aditivo: ${add.name}`],
    [`BDI: ${bdi.toFixed(2)}%   |   Status: ${add.status ?? 'rascunho'}`],
    [],
    synthHeader,
    ...synthRows,
  ]);

  const analyHeader = [
    'Item composição', 'Código composição', 'Descrição composição',
    'Código insumo', 'Banco', 'Descrição insumo',
    'Unidade', 'Coeficiente', 'V.Unit s/BDI', 'Total s/BDI',
  ];
  const analyRows: (string | number)[][] = [];
  for (const c of add.compositions) {
    for (const i of c.inputs) {
      analyRows.push([
        c.item, c.code, c.description,
        i.code, i.bank, i.description,
        i.unit, i.coefficient, i.unitPrice, i.total,
      ]);
    }
  }
  const wsAnaly = XLSX.utils.aoa_to_sheet([analyHeader, ...analyRows]);

  // Aba dedicada de Memória de Cálculo (vinculada à composição).
  // Loc é numérico automático (1..N por composição). Os cabeçalhos UND/Comprim./Largura/Altura
  // são padrões; quando a composição tiver rótulos personalizados, eles aparecem na coluna "Rótulos".
  const memHeader = [
    'Item composição', 'Código composição', 'Descrição composição',
    'Loc', 'Tipo', 'Comentário', 'Fórmula',
    'UND', 'Comprim.', 'Largura', 'Altura', 'Parcial',
    'Rótulos (UND|Comprim.|Largura|Altura)',
  ];
  const memRows: (string | number)[][] = [];
  for (const c of add.compositions) {
    const labels = resolveMemoryColumnLabels(c.calculationMemoryColumns);
    const labelsStr = `${labels.a}|${labels.b}|${labels.c}|${labels.d}`;
    validMemoryRows(c.calculationMemory).forEach((m, idx) => {
      memRows.push([
        c.item, c.code, c.description,
        idx + 1, m.type, m.comment ?? '', m.formula ?? '',
        m.a ?? '', m.b ?? '', m.c ?? '', m.d ?? '',
        Number.isFinite(m.partial) ? m.partial : 0,
        labelsStr,
      ]);
    });
  }
  const wsMem = XLSX.utils.aoa_to_sheet([memHeader, ...memRows]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSynth, 'Sintetica');
  XLSX.utils.book_append_sheet(wb, wsAnaly, 'Analitica');
  XLSX.utils.book_append_sheet(wb, wsMem, 'Memoria de Calculo');
  XLSX.writeFile(wb, `${add.name.replace(/[^\w\d-]+/g, '_')}.xlsx`);
}

export async function exportAdditiveToPdf(
  add: Additive,
  projectOrName: Project | string | null | undefined,
  showAnalytic: boolean,
) {
  const [jsPDFMod, autoTableMod, branding] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./companyBranding'),
  ]);
  const jsPDF = (jsPDFMod as any).default || (jsPDFMod as any).jsPDF || jsPDFMod;
  const autoTable = (autoTableMod as any).default || (autoTableMod as any).autoTable || autoTableMod;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 5;
  const safeAdd: Additive = (add ?? ({} as Additive));
  const additiveName = safeAdd.name || 'Aditivo';
  const compositions = safeAdd.compositions || [];
  const bdi = safeAdd.bdiPercent ?? 0;

  // Compat: aceita um Project completo (preferencial), apenas o nome (legado), ou null.
  const project: Project | null =
    projectOrName && typeof projectOrName !== 'string' ? projectOrName : null;
  const projectName =
    typeof projectOrName === 'string'
      ? (projectOrName || 'Obra')
      : (project?.name || 'Obra');
  const ci = project?.contractInfo || {};

  const logo = await branding.loadCompanyLogoForPdf().catch(() => null);
  const logoTargetW = 30;
  let logoH = 0;
  if (logo) {
    const ratio = logo.width / logo.height;
    logoH = logoTargetW / ratio;
    try { doc.addImage(logo.dataUrl, 'PNG', margin, margin, logoTargetW, logoH, undefined, 'FAST'); } catch {}
  }

  // Título centralizado (mesmo padrão da Medição)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(
    `ADITIVO — ${additiveName.toUpperCase()}`,
    pageWidth / 2, margin + 4, { align: 'center' },
  );

  let cursorY = Math.max(margin + 7, margin + logoH + 1);

  // Cabeçalho em grade no mesmo padrão da Medição
  const usable = pageWidth - margin * 2;
  const headerColWidths = [usable * 0.10, usable * 0.40, usable * 0.10, usable * 0.40];
  const fmtDateBR = (iso?: string) => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('pt-BR');
  };
  void fmtDateBR;
  const statusStr = (safeAdd.status ?? 'rascunho').toUpperCase();
  const issueStr = new Date().toLocaleDateString('pt-BR');
  const headerRows: [string, string, string, string][] = [
    ['Obra:', projectName || '-', 'Aditivo:', additiveName || '-'],
    ['Contratante:', ci.contractor || '-', 'Contratada:', ci.contracted || '-'],
    ['Objeto:', ci.contractObject || '-', 'Local/Município:', ci.location || '-'],
    ['Nº Contrato:', ci.contractNumber || '-', 'Nº ART:', ci.artNumber || '-'],
    ['Data emissão:', issueStr, 'Status:', statusStr],
    ['Fonte de orçamento:', ci.budgetSource || '-', 'BDI %:', `${bdi.toFixed(2)}`],
  ];
  autoTable(doc, {
    startY: cursorY,
    body: headerRows,
    theme: 'grid',
    styles: {
      font: 'helvetica', fontSize: 7.5, cellPadding: 1.4, overflow: 'linebreak',
      valign: 'middle', lineColor: [180, 180, 180], lineWidth: 0.15, textColor: 20,
    },
    columnStyles: {
      0: { cellWidth: headerColWidths[0], fontStyle: 'bold', fillColor: [243, 244, 246] },
      1: { cellWidth: headerColWidths[1] },
      2: { cellWidth: headerColWidths[2], fontStyle: 'bold', fillColor: [243, 244, 246] },
      3: { cellWidth: headerColWidths[3] },
    },
    margin: { left: margin, right: margin },
    tableWidth: usable,
  });
  cursorY = ((doc as any).lastAutoTable?.finalY ?? cursorY) + 2.5;

  const totals = additiveTotals(add, project);
  doc.setFontSize(8);
  const fmtBRL = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const summary = `Composições: ${totals.compCount} (acrescidas: ${totals.acrescidos} | suprimidas: ${totals.suprimidos})   |   Insumos: ${totals.inputCount}   |   Impacto s/BDI: ${fmtBRL(totals.impactoSemBDI)}   |   Impacto c/BDI: ${fmtBRL(totals.impactoComBDI)}`;
  doc.text(summary, margin, cursorY);
  cursorY += 4;

  const head = [[
    'Item', 'Código', 'Banco', 'Discriminação', 'Und',
    'Q.Contrat.', 'Suprim.', 'Aditiv.', 'Total após',
    'V.Unit s/BDI', 'V.Unit c/BDI', 'Impacto c/BDI',
  ]];

  for (const c of compositions) {
    const r = computeCompositionWithBDI(c, bdi);
    const body: any[] = [[
      c.item, c.code, c.bank, c.description, c.unit,
      (c.originalQuantity ?? 0).toLocaleString('pt-BR'),
      (c.suppressedQuantity ?? 0).toLocaleString('pt-BR'),
      (c.addedQuantity ?? c.quantity).toLocaleString('pt-BR'),
      totalAfterAdditive(c).toLocaleString('pt-BR'),
      fmtBRL(c.unitPriceNoBDI), fmtBRL(r.unitPriceWithBDI), fmtBRL(r.impactoComBDI),
    ]];

    autoTable(doc, {
      startY: cursorY, head, body,
      margin: { left: margin, right: margin },
      styles: { fontSize: 7.2, cellPadding: 1.3, overflow: 'linebreak' },
      headStyles: { fillColor: [40, 60, 90], textColor: 255 },
      columnStyles: {
        0: { cellWidth: 12 }, 1: { cellWidth: 16 }, 2: { cellWidth: 12 },
        3: { cellWidth: 'auto' }, 4: { cellWidth: 10 },
        5: { cellWidth: 16, halign: 'right' }, 6: { cellWidth: 14, halign: 'right' },
        7: { cellWidth: 14, halign: 'right' }, 8: { cellWidth: 16, halign: 'right' },
        9: { cellWidth: 20, halign: 'right' }, 10: { cellWidth: 20, halign: 'right' },
        11: { cellWidth: 22, halign: 'right' },
      },
    });
    cursorY = (doc as any).lastAutoTable.finalY + 1;

    if (showAnalytic && (c.inputs?.length ?? 0) > 0) {
      autoTable(doc, {
        startY: cursorY,
        head: [['', 'Cód.', 'Banco', 'Descrição insumo', 'Un', 'Coef.', 'V.Unit s/BDI', 'Total s/BDI']],
        body: (c.inputs ?? []).map(i => [
          '', i.code, i.bank, i.description, i.unit,
          i.coefficient.toLocaleString('pt-BR'), fmtBRL(i.unitPrice), fmtBRL(i.total),
        ]),
        margin: { left: margin + 6, right: margin },
        styles: { fontSize: 6.8, cellPadding: 1.1, overflow: 'linebreak', textColor: 60 },
        headStyles: { fillColor: [220, 225, 235], textColor: 30 },
        columnStyles: {
          0: { cellWidth: 4 }, 3: { cellWidth: 'auto' },
          5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' },
        },
      });
      cursorY = (doc as any).lastAutoTable.finalY + 3;
    } else {
      cursorY += 2;
    }

    const memRows = validMemoryRows(c.calculationMemory);
    if (memRows.length > 0) {
      const memLabels = resolveMemoryColumnLabels(c.calculationMemoryColumns);
      let memAdded = 0;
      let memSuppressed = 0;
      const body = memRows.map((m, idx) => {
        const p = Number.isFinite(m.partial) ? m.partial : 0;
        if (m.type === 'suprimida') memSuppressed += p; else memAdded += p;
        return [
          String(idx + 1),
          m.type === 'suprimida' ? 'Suprimida' : 'Acrescida',
          m.comment ?? '',
          m.formula ?? '',
          m.a ?? '', m.b ?? '', m.c ?? '', m.d ?? '',
          p.toLocaleString('pt-BR', { maximumFractionDigits: 4 }),
        ];
      });
      body.push([
        '', '', '', '', '', '', '', 'Total Acrescida:',
        memAdded.toLocaleString('pt-BR', { maximumFractionDigits: 4 }),
      ]);
      body.push([
        '', '', '', '', '', '', '', 'Total Suprimida:',
        memSuppressed.toLocaleString('pt-BR', { maximumFractionDigits: 4 }),
      ]);
      autoTable(doc, {
        startY: cursorY,
        head: [['Loc', 'Tipo', 'Comentário', 'Fórmula', memLabels.a, memLabels.b, memLabels.c, memLabels.d, 'Parcial']],
        body,
        margin: { left: margin + 6, right: margin },
        styles: { fontSize: 6.8, cellPadding: 1.1, overflow: 'linebreak', textColor: 60 },
        headStyles: { fillColor: [225, 220, 240], textColor: 30 },
        columnStyles: {
          0: { halign: 'center', cellWidth: 8 },
          1: { cellWidth: 16 },
          2: { cellWidth: 'auto' },
          3: { cellWidth: 22 },
          4: { halign: 'right', cellWidth: 12 }, 5: { halign: 'right', cellWidth: 14 },
          6: { halign: 'right', cellWidth: 12 }, 7: { halign: 'right', cellWidth: 12 },
          8: { halign: 'right', cellWidth: 18 },
        },
      });
      cursorY = (doc as any).lastAutoTable.finalY + 3;
    }

    if (cursorY > doc.internal.pageSize.getHeight() - 20) {
      doc.addPage();
      cursorY = margin;
    }
  }

  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(120);
    const footer = `${branding.company.name} · ${branding.company.cnpj} · ${branding.company.city}`;
    doc.text(footer, pageWidth / 2, doc.internal.pageSize.getHeight() - 5, { align: 'center' });
    doc.text(`Pág. ${p}/${pageCount}`, pageWidth - margin, doc.internal.pageSize.getHeight() - 5, { align: 'right' });
  }

  const safeFileName = (additiveName || 'Aditivo').replace(/[^\w\d-]+/g, '_') || 'Aditivo';
  doc.save(`${safeFileName}.pdf`);
}

// ============= Novos serviços (estudo no Aditivo) =============

/**
 * Calcula o próximo número de item dentro de um capítulo/subcapítulo no aditivo,
 * baseado nas composições existentes vinculadas àquela phaseId.
 * Ex.: se existe "2.1.11", retorna "2.1.12". Se não há nada, retorna `${parentNumber}.1`.
 */
export function nextItemNumberInPhase(
  add: Additive,
  phaseId: string,
  parentNumber: string,
): string {
  const prefix = parentNumber + '.';
  let max = 0;
  for (const c of add.compositions) {
    if (c.phaseId !== phaseId) continue;
    const num = c.itemNumber || c.item || '';
    if (num.startsWith(prefix)) {
      const tail = num.slice(prefix.length);
      const seg = tail.split('.')[0];
      const n = parseInt(seg, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${max + 1}`;
}

/** Cria uma composição vazia de "novo serviço" para inserir num subcapítulo. */
export function createNewServiceComposition(
  add: Additive,
  phaseId: string,
  phaseChain: string,
  parentNumber: string,
): AdditiveComposition {
  const itemNumber = nextItemNumberInPhase(add, phaseId, parentNumber);
  return {
    id: uid(),
    item: itemNumber,
    code: '',
    bank: '',
    description: 'Novo serviço',
    quantity: 0,
    unit: 'un',
    unitPriceNoBDI: 0,
    unitPriceWithBDI: 0,
    total: 0,
    inputs: [],
    source: 'manual',
    changeKind: 'acrescido',
    originalQuantity: 0,
    addedQuantity: 0,
    suppressedQuantity: 0,
    phaseId,
    phaseChain,
    itemNumber,
    isNewService: true,
    unitPriceNoBDIInformed: 0,
  };
}

/**
 * Marca o aditivo como contratado e cria as tarefas dos novos serviços na EAP,
 * dentro dos respectivos capítulos/subcapítulos. Retorna o projeto atualizado.
 */
export function contractAdditive(project: Project, additiveId: string): Project {
  const add = (project.additives ?? []).find(a => a.id === additiveId);
  if (!add) return project;
  const bdi = add.bdiPercent ?? 0;
  const discount = add.globalDiscountPercent ?? 0;
  const fator = 1 + bdi / 100;

  // Indexa novos serviços por phaseId
  const novos = add.compositions.filter(c => c.isNewService);

  // Cria tarefas na EAP para cada novo serviço, dentro do phaseId correspondente.
  const phases = project.phases.map(phase => {
    const novosDaFase = novos.filter(n => n.phaseId === phase.id);
    if (novosDaFase.length === 0) return phase;
    const newTasks: Task[] = novosDaFase.map(n => {
      const referenceUnit = referenceUnitNoBDIForNewService(n);
      const baseUnitNoBDI = money2(referenceUnit * (1 - discount / 100));
      const upWithBDI = truncar2(baseUnitNoBDI * fator);
      const qty = n.addedQuantity ?? 0;
      const taskId = `add-${add.id}-${n.id}`;
      return {
        id: taskId,
        name: n.description || 'Novo serviço (Aditivo)',
        phase: phase.id,
        startDate: project.startDate,
        duration: 1,
        dependencies: [],
        responsible: '',
        percentComplete: 0,
        materials: [],
        level: 0,
        quantity: qty,
        unit: n.unit,
        unitPrice: upWithBDI,
        unitPriceNoBDI: baseUnitNoBDI,
        itemCode: n.code,
        priceBank: n.bank,
        durationMode: 'manual',
        isManual: true,
        manualDuration: 1,
      } as Task;
    });
    return { ...phase, tasks: [...phase.tasks, ...newTasks] };
  });

  const updatedAdditive: Additive = {
    ...add,
    status: 'aditivo_contratado',
    isContracted: true,
    contractedAt: new Date().toISOString(),
  };
  const nextAdditives = (project.additives ?? []).map(a => a.id === add.id ? updatedAdditive : a);

  // Recalcula budgetItems source 'aditivo' considerando o aditivo contratado
  const projWithChange: Project = { ...project, phases, additives: nextAdditives };
  const approvedBudget = getApprovedAdditiveBudgetItems(projWithChange);
  const keep = (project.budgetItems ?? []).filter(b => b.source !== 'aditivo');
  return { ...projWithChange, budgetItems: [...keep, ...approvedBudget] };
}
