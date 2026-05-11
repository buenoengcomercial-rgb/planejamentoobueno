/**
 * Exportadores formais (Excel + PDF) da aba Aditivo.
 *
 * Não recalcula valores: reaproveita computeAdditiveRow, additiveTotals,
 * referenceUnitNoBDIForNewService, validMemoryRows e resolveMemoryColumnLabels.
 *
 * Visual semelhante ao painel da aba Aditivo (grupos de colunas coloridos,
 * destaque para suprimido/acrescido, linhas de capítulo/subcapítulo, novos
 * serviços e itens alterados).
 */
import type { Project, Additive, AdditiveComposition } from '@/types/project';
import {
  computeAdditiveRow,
  additiveTotals,
  referenceUnitNoBDIForNewService,
  totalAfterAdditive,
  money2,
} from './additiveImport';
import { trunc2 } from './financialEngine';
import { resolveMemoryColumnLabels, validMemoryRows } from './calculationMemory';
import { getChapterTree, getChapterNumbering, type ChapterNode } from './chapters';
import { loadCompanyLogoForPdf, company } from './companyBranding';

// ---------- Paleta (espelha o painel) ----------
const COLOR = {
  ident: 'E2E8F0',       // slate-200
  qty: 'DBEAFE',         // blue-100  (quantidades)
  qtyHead: 'BFDBFE',     // blue-200
  val: 'EFF6FF',         // sky-50
  valHead: 'DBEAFE',     // sky-100
  impact: 'D1FAE5',      // emerald-100
  impactHead: 'A7F3D0',  // emerald-200
  suprimidoBg: 'FEE2E2', // rose-100
  suprimidoFg: 'B91C1C', // red-700
  acrescidoBg: 'DCFCE7', // green-100
  acrescidoFg: '047857', // emerald-700
  novoServico: 'EFF6FF', // azul claro p/ linha inteira
  itemAlterado: 'FEF9C3',// yellow-100
  chapter: 'F1F5F9',     // slate-100
  subtotal: 'E5E7EB',    // gray-200
  totalGeralBg: '1F2937',// gray-800
  totalGeralFg: 'FFFFFF',
  headerBlack: '1E293B', // slate-800
  headerWhite: 'FFFFFF',
  brandBg: 'F8FAFC',
  border: 'CBD5E1',
};

const FMT_BRL = 'R$ #,##0.00;[Red]-R$ #,##0.00;R$ 0.00';
const FMT_QTD = '#,##0.00';
const FMT_PCT = '0.00%';

// ---------- Normalizadores numéricos para a planilha ----------
// Truncam (não arredondam) para evitar números do tipo 32.996846999999995.
function q2(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n * 100) / 100;
}
function moneyExcel(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n * 100) / 100;
}
function pctExcel(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n * 10000) / 10000;
}
function estimateRowHeight(description: string): number {
  const len = (description || '').length;
  if (len <= 60) return 22;
  if (len <= 120) return 34;
  if (len <= 220) return 46;
  return 58;
}

function downloadXlsxBlob(XLSX: any, wb: any, fileName: string) {
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

function downloadPdfBlob(doc: any, fileName: string) {
  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

function safeFile(name: string): string {
  return (name || 'aditivo').replace(/[^\w\d-]+/g, '_').replace(/^_+|_+$/g, '');
}

function fmtDateBR(iso?: string | Date): string {
  if (!iso) return '-';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('pt-BR');
}

function statusLabel(s?: string): string {
  switch (s) {
    case 'rascunho': return 'Rascunho';
    case 'em_analise': return 'Em análise fiscal';
    case 'reprovado': return 'Reprovado';
    case 'aprovado': return 'Aprovado';
    case 'aditivo_contratado': return 'Aditivo Contratado';
    default: return String(s ?? '-');
  }
}

// ============================================================
// Caminhada por capítulos (independente — não usa o walker interno)
// ============================================================
interface ChapterInfo { id: string; number: string; name: string; depth: number; }
interface WalkerHandlers {
  onChapterStart?: (ch: ChapterInfo) => void;
  onComposition?: (c: AdditiveComposition, ch: ChapterInfo | null) => void;
  onChapterEnd?: (ch: ChapterInfo, descendants: AdditiveComposition[]) => void;
  onOrphanStart?: () => void;
}

function walkByChapters(
  project: Project,
  add: Additive,
  filter: (c: AdditiveComposition) => boolean,
  h: WalkerHandlers,
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
  const collect = (n: ChapterNode): AdditiveComposition[] => {
    const dr = byPhase.get(n.phase.id) ?? [];
    const sub: AdditiveComposition[] = [];
    n.children.forEach(c2 => sub.push(...collect(c2)));
    return [...dr, ...sub];
  };
  const emit = (n: ChapterNode, depth: number) => {
    const direct = byPhase.get(n.phase.id) ?? [];
    const desc: AdditiveComposition[] = [];
    n.children.forEach(c => desc.push(...collect(c)));
    if (direct.length === 0 && desc.length === 0) return;
    const info: ChapterInfo = {
      id: n.phase.id, number: numbering.get(n.phase.id) || '',
      name: n.phase.name, depth,
    };
    h.onChapterStart?.(info);
    direct.forEach(c => h.onComposition?.(c, info));
    n.children.forEach(c => emit(c, depth + 1));
    h.onChapterEnd?.(info, [...direct, ...desc]);
  };
  tree.forEach(n => emit(n, 0));
  if (orphans.length > 0) {
    h.onOrphanStart?.();
    orphans.forEach(c => h.onComposition?.(c, null));
  }
}

// ============================================================
// EXCEL (xlsx-js-style)
// ============================================================

type Cell = string | number | { v: string | number; s?: any; z?: string };
type Row = Cell[];

function tCell(v: string | number, fill?: string, bold = false, color?: string, hAlign?: 'left' | 'center' | 'right'): any {
  const s: any = {
    font: { name: 'Arial', sz: 10, bold, color: color ? { rgb: color } : { rgb: '111827' } },
    alignment: { vertical: 'center', horizontal: hAlign ?? (typeof v === 'number' ? 'right' : 'left'), wrapText: true },
    border: {
      top: { style: 'thin', color: { rgb: COLOR.border } },
      bottom: { style: 'thin', color: { rgb: COLOR.border } },
      left: { style: 'thin', color: { rgb: COLOR.border } },
      right: { style: 'thin', color: { rgb: COLOR.border } },
    },
  };
  if (fill) s.fill = { patternType: 'solid', fgColor: { rgb: fill } };
  return { v, s };
}

function nCell(v: number, fmt: string, fill?: string, color?: string, bold = false, hAlign: 'left' | 'center' | 'right' = 'center'): any {
  const c = tCell(v, fill, bold, color, hAlign);
  c.z = fmt;
  c.t = 'n';
  c.s.numFmt = fmt;
  return c;
}

// Cria uma célula "vazia" mas com fundo (preserva cor de coluna em linhas mescladas/subtotais).
function fillCell(fill?: string): any {
  return {
    v: '',
    s: {
      fill: fill ? { patternType: 'solid', fgColor: { rgb: fill } } : undefined,
      border: {
        top: { style: 'thin', color: { rgb: COLOR.border } },
        bottom: { style: 'thin', color: { rgb: COLOR.border } },
        left: { style: 'thin', color: { rgb: COLOR.border } },
        right: { style: 'thin', color: { rgb: COLOR.border } },
      },
    },
  };
}

// ---------- Helpers tipados (mantêm formatação consistente) ----------
function textCell(v: string | number, fill?: string, bold = false, color?: string, hAlign?: 'left' | 'center' | 'right'): any {
  return tCell(v, fill, bold, color, hAlign);
}
function moneyCell(v: unknown, fill?: string, color?: string, bold = false): any {
  return nCell(moneyExcel(v), FMT_BRL, fill, color, bold, 'center');
}
function qtyCell(v: unknown, fill?: string, color?: string, bold = false): any {
  return nCell(q2(v), FMT_QTD, fill, color, bold, 'center');
}
function percentCell(v: unknown, fill?: string, color?: string, bold = false): any {
  return nCell(pctExcel(v), FMT_PCT, fill, color, bold, 'center');
}

function buildFormalHeaderBlock(
  project: Project,
  add: Additive,
  reportTitle: string,
  totalCols: number,
  logoDataUrl: string | null,
): { rows: Row[]; merges: any[]; rowHeights: number[] } {
  const ci = project.contractInfo || {};
  const rows: Row[] = [];
  const merges: any[] = [];
  const rowHeights: number[] = [];
  const cw = totalCols;

  // Linha 1: título (mesclada total)
  const titleCell = {
    v: `${(company?.name || 'Empresa').toUpperCase()} — ${reportTitle}`,
    s: {
      font: { name: 'Arial', sz: 14, bold: true, color: { rgb: COLOR.headerWhite } },
      alignment: { vertical: 'center', horizontal: 'center' },
      fill: { patternType: 'solid', fgColor: { rgb: COLOR.headerBlack } },
    },
  };
  rows.push([titleCell, ...Array(cw - 1).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: COLOR.headerBlack } } } })]);
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: cw - 1 } });
  rowHeights.push(28);

  // Linha 2: subtítulo / nome obra
  const sub = {
    v: `Obra: ${project.name || '-'}   |   Aditivo: ${add.name || '-'}   |   Status: ${statusLabel(add.status)}`,
    s: {
      font: { name: 'Arial', sz: 10, bold: true, color: { rgb: '0F172A' } },
      alignment: { vertical: 'center', horizontal: 'center' },
      fill: { patternType: 'solid', fgColor: { rgb: COLOR.brandBg } },
    },
  };
  rows.push([sub, ...Array(cw - 1).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: COLOR.brandBg } } } })]);
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: cw - 1 } });
  rowHeights.push(20);

  // Bloco de dados em grade — 4 colunas lógicas (label | value | label | value),
  // distribuídas em quartos da largura.
  const q = Math.max(1, Math.floor(cw / 4));
  const lab = (txt: string) => ({
    v: txt, s: {
      font: { name: 'Arial', sz: 9, bold: true, color: { rgb: '334155' } },
      alignment: { vertical: 'center', horizontal: 'left' },
      fill: { patternType: 'solid', fgColor: { rgb: COLOR.ident } },
      border: {
        top: { style: 'thin', color: { rgb: COLOR.border } },
        bottom: { style: 'thin', color: { rgb: COLOR.border } },
        left: { style: 'thin', color: { rgb: COLOR.border } },
        right: { style: 'thin', color: { rgb: COLOR.border } },
      },
    },
  });
  const val = (txt: string) => ({
    v: txt, s: {
      font: { name: 'Arial', sz: 9, color: { rgb: '0F172A' } },
      alignment: { vertical: 'center', horizontal: 'left', wrapText: true },
      border: {
        top: { style: 'thin', color: { rgb: COLOR.border } },
        bottom: { style: 'thin', color: { rgb: COLOR.border } },
        left: { style: 'thin', color: { rgb: COLOR.border } },
        right: { style: 'thin', color: { rgb: COLOR.border } },
      },
    },
  });

  const pairs: Array<[string, string, string, string]> = [
    ['Contratante:', ci.contractor || '-', 'Contratada:', ci.contracted || '-'],
    ['Local/Município:', ci.location || '-', 'Objeto:', ci.contractObject || '-'],
    ['Nº Contrato:', ci.contractNumber || '-', 'Nº ART:', ci.artNumber || '-'],
    ['Fonte de orçamento:', ci.budgetSource || '-', 'Nome do aditivo:', add.name || '-'],
    ['BDI %:', `${(add.bdiPercent ?? 0).toFixed(2)}%`, 'Desconto Licit. %:', `${(add.globalDiscountPercent ?? 0).toFixed(2)}%`],
    ['Data emissão:', fmtDateBR(add.headerIssueDate || new Date()), 'Responsável:', add.headerResponsible || add.approvedBy || '-'],
  ];

  const headerStartRow = rows.length;
  pairs.forEach(([l1, v1, l2, v2]) => {
    const row: Row = Array(cw).fill('');
    row[0] = lab(l1);
    row[q] = val(v1);
    row[2 * q] = lab(l2);
    row[3 * q] = val(v2);
    rows.push(row);
    rowHeights.push(18);
  });
  // Merges dos campos
  for (let i = 0; i < pairs.length; i++) {
    const r = headerStartRow + i;
    merges.push({ s: { r, c: 0 }, e: { r, c: q - 1 } });
    merges.push({ s: { r, c: q }, e: { r, c: 2 * q - 1 } });
    merges.push({ s: { r, c: 2 * q }, e: { r, c: 3 * q - 1 } });
    merges.push({ s: { r, c: 3 * q }, e: { r, c: cw - 1 } });
  }

  // Linha em branco separadora
  rows.push(Array(cw).fill(''));
  rowHeights.push(8);

  // Logo (best-effort): se houver, ocupa célula A1..B2 visualmente — sheetjs não embute imagens.
  // Mantemos identidade no título; logo aparece no PDF.
  void logoDataUrl;

  return { rows, merges, rowHeights };
}

function pushGroupHeader(
  rows: Row[],
  merges: any[],
  rowHeights: number[],
  groups: Array<{ label: string; span: number; fill: string }>,
  subHeaders: string[],
  fillsBySubCol: string[],
  fontColorsBySubCol?: (string | undefined)[],
) {
  const r0 = rows.length;
  const groupRow: Row = [];
  let col = 0;
  for (const g of groups) {
    groupRow.push({
      v: g.label,
      s: {
        font: { name: 'Arial', sz: 10, bold: true, color: { rgb: '0F172A' } },
        alignment: { vertical: 'center', horizontal: 'center' },
        fill: { patternType: 'solid', fgColor: { rgb: g.fill } },
        border: {
          top: { style: 'thin', color: { rgb: COLOR.border } },
          bottom: { style: 'thin', color: { rgb: COLOR.border } },
          left: { style: 'thin', color: { rgb: COLOR.border } },
          right: { style: 'thin', color: { rgb: COLOR.border } },
        },
      },
    });
    for (let i = 1; i < g.span; i++) {
      groupRow.push({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: g.fill } } } });
    }
    if (g.span > 1) merges.push({ s: { r: r0, c: col }, e: { r: r0, c: col + g.span - 1 } });
    col += g.span;
  }
  rows.push(groupRow);
  rowHeights.push(20);

  // Sub-headers
  rows.push(subHeaders.map((h, i) => {
    const fg = fontColorsBySubCol?.[i] || '0F172A';
    return {
      v: h,
      s: {
        font: { name: 'Arial', sz: 9, bold: true, color: { rgb: fg } },
        alignment: { vertical: 'center', horizontal: 'center', wrapText: true },
        fill: { patternType: 'solid', fgColor: { rgb: fillsBySubCol[i] || COLOR.ident } },
        border: {
          top: { style: 'thin', color: { rgb: COLOR.border } },
          bottom: { style: 'thin', color: { rgb: COLOR.border } },
          left: { style: 'thin', color: { rgb: COLOR.border } },
          right: { style: 'thin', color: { rgb: COLOR.border } },
        },
      },
    };
  }));
  rowHeights.push(28);
}

async function loadXLSXStyle() {
  const mod: any = await import('xlsx-js-style');
  return mod.default ?? mod;
}

// ---------- Exportador 1: Sintética Completa (Excel) ----------
export async function exportAdditiveSyntheticCompletePro(project: Project, add: Additive) {
  const XLSX = await loadXLSXStyle();
  const bdi = add.bdiPercent ?? 0;
  const discount = add.globalDiscountPercent ?? 0;

  // 19 colunas conforme spec
  const SUB = [
    'Item', 'Código', 'Banco', 'Descrição', 'Und',                     // 5 ident
    'Qtd Contratada', 'Qtd Suprimida', 'Qtd Acrescida', 'Qtd Final',   // 4 qtd
    'Valor Unit', 'Valor Unit c/ BDI', 'Total Fonte', 'Valor Contratado', // 4 val
    'Valor Suprimido', 'Valor Acrescido', 'Valor Final', 'Diferença', '% Var.', // 5 impact
    'Situação',
  ];
  const totalCols = SUB.length;
  const groups = [
    { label: 'IDENTIFICAÇÃO', span: 5, fill: COLOR.ident },
    { label: 'QUANTIDADES',  span: 4, fill: COLOR.qtyHead },
    { label: 'VALORES',      span: 4, fill: COLOR.valHead },
    { label: 'IMPACTO DO ADITIVO', span: 5, fill: COLOR.impactHead },
    { label: 'SITUAÇÃO',     span: 1, fill: COLOR.ident },
  ];
  const subFills = [
    COLOR.ident, COLOR.ident, COLOR.ident, COLOR.ident, COLOR.ident,
    COLOR.qty, COLOR.suprimidoBg, COLOR.acrescidoBg, COLOR.qty,
    COLOR.val, COLOR.val, COLOR.val, COLOR.val,
    COLOR.suprimidoBg, COLOR.acrescidoBg, COLOR.impact, COLOR.impact, COLOR.impact,
    COLOR.ident,
  ];

  const merges: any[] = [];
  const rowHeights: number[] = [];
  const rows: Row[] = [];

  const hdr = buildFormalHeaderBlock(project, add, 'ADITIVO — SINTÉTICA COMPLETA', totalCols, null);
  rows.push(...hdr.rows);
  merges.push(...hdr.merges);
  rowHeights.push(...hdr.rowHeights);

  const subFontColors: (string | undefined)[] = [
    undefined, undefined, undefined, undefined, undefined,
    undefined, COLOR.suprimidoFg, COLOR.acrescidoFg, undefined,
    undefined, undefined, undefined, undefined,
    COLOR.suprimidoFg, COLOR.acrescidoFg, undefined, undefined, undefined,
    undefined,
  ];
  pushGroupHeader(rows, merges, rowHeights, groups, SUB, subFills, subFontColors);

  const pushChapter = (number: string, name: string, depth: number) => {
    const r0 = rows.length;
    const txt = `${'    '.repeat(depth)}${number} ${name}`;
    rows.push([{
      v: txt,
      s: {
        font: { name: 'Arial', sz: 10, bold: true, color: { rgb: '0F172A' } },
        alignment: { vertical: 'center', horizontal: 'left' },
        fill: { patternType: 'solid', fgColor: { rgb: COLOR.chapter } },
        border: {
          top: { style: 'thin', color: { rgb: COLOR.border } },
          bottom: { style: 'thin', color: { rgb: COLOR.border } },
          left: { style: 'thin', color: { rgb: COLOR.border } },
          right: { style: 'thin', color: { rgb: COLOR.border } },
        },
      },
    }, ...Array(totalCols - 1).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: COLOR.chapter } } } })]);
    merges.push({ s: { r: r0, c: 0 }, e: { r: r0, c: totalCols - 1 } });
    rowHeights.push(20);
  };

  const pushComp = (c: AdditiveComposition) => {
    const r = computeAdditiveRow(c, bdi, discount);
    let situacao = 'Sem alteração';
    let rowFill: string | undefined = undefined;
    if (c.isNewService) { situacao = 'Novo serviço aditivado'; rowFill = COLOR.novoServico; }
    else if ((c.suppressedQuantity ?? 0) > 0 || (c.addedQuantity ?? 0) > 0) {
      situacao = 'Item contratado alterado'; rowFill = COLOR.itemAlterado;
    }
    // Cor de coluna sempre aplicada (igual ao painel), independente do valor.
    const supBg = COLOR.suprimidoBg;
    const acrBg = COLOR.acrescidoBg;
    const supFg = COLOR.suprimidoFg;
    const acrFg = COLOR.acrescidoFg;

    rows.push([
      tCell(c.item || '', rowFill),
      tCell(c.code || '', rowFill),
      tCell(c.bank || '', rowFill),
      tCell(c.description || '', rowFill),
      tCell(c.unit || '', rowFill, false, undefined, 'center'),
      nCell(q2(r.qtdContratada), FMT_QTD, rowFill),
      nCell(q2(r.qtdSuprimida), FMT_QTD, supBg, supFg),
      nCell(q2(r.qtdAcrescida), FMT_QTD, acrBg, acrFg),
      nCell(q2(r.qtdFinal), FMT_QTD, rowFill),
      nCell(moneyExcel(r.unitPriceNoBDI), FMT_BRL, rowFill),
      nCell(moneyExcel(r.unitPriceWithBDI), FMT_BRL, rowFill),
      nCell(moneyExcel(r.totalFonte), FMT_BRL, rowFill),
      nCell(moneyExcel(r.valorContratadoOriginalPreservado), FMT_BRL, rowFill),
      nCell(moneyExcel(r.valorSuprimido), FMT_BRL, supBg, supFg),
      nCell(moneyExcel(r.valorAcrescido), FMT_BRL, acrBg, acrFg),
      nCell(moneyExcel(r.valorFinal), FMT_BRL, rowFill),
      nCell(moneyExcel(r.diferenca), FMT_BRL, rowFill),
      nCell(pctExcel(r.percentVar), FMT_PCT, rowFill),
      tCell(situacao, rowFill, false, undefined, 'left'),
    ]);
    rowHeights.push(estimateRowHeight(c.description || ''));
  };

  const pushSubtotal = (number: string, name: string, depth: number, descendants: AdditiveComposition[]) => {
    let sFonte = 0, sContr = 0, sSup = 0, sAcr = 0, sFinal = 0, sDif = 0;
    descendants.forEach(c => {
      const r = computeAdditiveRow(c, bdi, discount);
      sFonte += r.totalFonte;
      sContr += r.valorContratadoOriginalPreservado;
      sSup += r.valorSuprimido;
      sAcr += r.valorAcrescido;
      sFinal += r.valorFinal;
      sDif += r.diferenca;
    });
    const fill = COLOR.subtotal;
    const label = `${'    '.repeat(depth)}Subtotal ${number} — ${name}`;
    const r0 = rows.length;
    rows.push([
      tCell(label, fill, true, undefined, 'left'),
      ...Array(10).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: fill } } } }),
      nCell(moneyExcel(sFonte), FMT_BRL, fill, undefined, true),
      nCell(moneyExcel(sContr), FMT_BRL, fill, undefined, true),
      nCell(moneyExcel(sSup), FMT_BRL, COLOR.suprimidoBg, COLOR.suprimidoFg, true),
      nCell(moneyExcel(sAcr), FMT_BRL, COLOR.acrescidoBg, COLOR.acrescidoFg, true),
      nCell(moneyExcel(sFinal), FMT_BRL, fill, undefined, true),
      nCell(moneyExcel(sDif), FMT_BRL, fill, undefined, true),
      tCell('', fill), tCell('', fill),
    ]);
    merges.push({ s: { r: r0, c: 0 }, e: { r: r0, c: 10 } });
    rowHeights.push(18);
  };

  walkByChapters(project, add, () => true, {
    onChapterStart: ch => pushChapter(ch.number, ch.name, ch.depth),
    onComposition: pushComp,
    onChapterEnd: (ch, descendants) => pushSubtotal(ch.number, ch.name, ch.depth, descendants),
    onOrphanStart: () => pushChapter('—', 'Sem capítulo (não vinculado à EAP)', 0),
  });

  // TOTAL GERAL
  const t = additiveTotals(add, project);
  const fillT = COLOR.totalGeralBg;
  const fgT = COLOR.totalGeralFg;
  const totalRowIdx = rows.length;
  rows.push([
    tCell('TOTAL GERAL', fillT, true, fgT, 'left'),
    ...Array(10).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: fillT } } } }),
    tCell('', fillT),
    nCell(moneyExcel(t.totalContratadoOriginal), FMT_BRL, fillT, fgT, true),
    nCell(moneyExcel(t.totalSuprimido), FMT_BRL, COLOR.suprimidoBg, COLOR.suprimidoFg, true),
    nCell(moneyExcel(t.totalAcrescido), FMT_BRL, COLOR.acrescidoBg, COLOR.acrescidoFg, true),
    nCell(moneyExcel(t.valorFinal), FMT_BRL, fillT, fgT, true),
    nCell(moneyExcel(t.diferencaLiquida), FMT_BRL, fillT, fgT, true),
    nCell(pctExcel(t.percentVariacaoLiquida), FMT_PCT, fillT, fgT, true),
    tCell('', fillT),
  ]);
  merges.push({ s: { r: totalRowIdx, c: 0 }, e: { r: totalRowIdx, c: 10 } });
  rowHeights.push(24);

  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(c => (c && typeof c === 'object') ? (c as any).v : c)));
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const cell = rows[r][c];
      if (cell && typeof cell === 'object') {
        const ref = XLSX.utils.encode_cell({ r, c });
        ws[ref] = cell;
      }
    }
  }
  ws['!cols'] = [
    { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 38 }, { wch: 6 },
    { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 10 },
    { wch: 12 }, { wch: 13 }, { wch: 13 }, { wch: 14 },
    { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 8 },
    { wch: 18 },
  ];
  ws['!merges'] = merges;
  ws['!rows'] = rowHeights.map(h => ({ hpt: h }));
  const subHeaderRowIdx = hdr.rows.length + 1;
  const firstDataRowIdx = subHeaderRowIdx + 1;
  (ws as any)['!views'] = [{ state: 'frozen', ySplit: firstDataRowIdx }];
  const lastRowIdx = rows.length - 1;
  ws['!autofilter'] = {
    ref: `${XLSX.utils.encode_cell({ r: subHeaderRowIdx, c: 0 })}:${XLSX.utils.encode_cell({ r: lastRowIdx, c: totalCols - 1 })}`,
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sintética Completa');
  downloadXlsxBlob(XLSX, wb, `aditivo_sintetica_completa_${safeFile(add.name)}.xlsx`);
}

// ---------- Exportador 2: Novas Composições (Excel) ----------
export async function exportAdditiveNewServicesPro(project: Project, add: Additive) {
  const XLSX = await loadXLSXStyle();
  const bdi = add.bdiPercent ?? 0;
  const discount = add.globalDiscountPercent ?? 0;

  const SUB = [
    'Item', 'Código', 'Banco', 'Descrição', 'Und',
    'Qtd Acrescida',
    'V. Unit Ref. s/ BDI', 'Desc. Licit. %', 'V. Unit s/ BDI c/ Desc.', 'BDI %', 'V. Unit c/ BDI',
    'Valor Acrescido', 'Valor Final',
    'Fonte / Observação',
  ];
  const totalCols = SUB.length;
  const groups = [
    { label: 'IDENTIFICAÇÃO', span: 5, fill: COLOR.ident },
    { label: 'QUANTIDADE', span: 1, fill: COLOR.qtyHead },
    { label: 'VALORES', span: 5, fill: COLOR.valHead },
    { label: 'IMPACTO DO ADITIVO', span: 2, fill: COLOR.impactHead },
    { label: 'OBSERVAÇÃO', span: 1, fill: COLOR.ident },
  ];
  const subFills = [
    COLOR.ident, COLOR.ident, COLOR.ident, COLOR.ident, COLOR.ident,
    COLOR.acrescidoBg,
    COLOR.val, COLOR.val, COLOR.val, COLOR.val, COLOR.val,
    COLOR.acrescidoBg, COLOR.impact,
    COLOR.ident,
  ];
  const subFontColors: (string | undefined)[] = [
    undefined, undefined, undefined, undefined, undefined,
    COLOR.acrescidoFg,
    undefined, undefined, undefined, undefined, undefined,
    COLOR.acrescidoFg, undefined,
    undefined,
  ];

  const rows: Row[] = [];
  const merges: any[] = [];
  const rowHeights: number[] = [];

  const hdr = buildFormalHeaderBlock(project, add, 'ADITIVO — NOVAS COMPOSIÇÕES', totalCols, null);
  rows.push(...hdr.rows); merges.push(...hdr.merges); rowHeights.push(...hdr.rowHeights);
  pushGroupHeader(rows, merges, rowHeights, groups, SUB, subFills, subFontColors);

  const rowFill = COLOR.novoServico;
  let totAcr = 0, totFinal = 0;

  walkByChapters(project, add, c => !!c.isNewService, {
    onChapterStart: ch => {
      const r0 = rows.length;
      rows.push([{
        v: `${'    '.repeat(ch.depth)}${ch.number} ${ch.name}`,
        s: {
          font: { name: 'Arial', sz: 10, bold: true },
          alignment: { vertical: 'center', horizontal: 'left' },
          fill: { patternType: 'solid', fgColor: { rgb: COLOR.chapter } },
        },
      }, ...Array(totalCols - 1).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: COLOR.chapter } } } })]);
      merges.push({ s: { r: r0, c: 0 }, e: { r: r0, c: totalCols - 1 } });
      rowHeights.push(20);
    },
    onComposition: c => {
      const r = computeAdditiveRow(c, bdi, discount);
      const refUnit = referenceUnitNoBDIForNewService(c);
      const obs = c.bank ? `Fonte: ${c.bank}` : 'Novo serviço aditivado';
      rows.push([
        tCell(c.item || '', rowFill),
        tCell(c.code || '', rowFill),
        tCell(c.bank || '', rowFill),
        tCell(c.description || '', rowFill),
        tCell(c.unit || '', rowFill, false, undefined, 'center'),
        nCell(q2(r.qtdAcrescida), FMT_QTD, COLOR.acrescidoBg, COLOR.acrescidoFg),
        nCell(moneyExcel(refUnit), FMT_BRL, rowFill),
        nCell(pctExcel((discount || 0) / 100), FMT_PCT, rowFill),
        nCell(moneyExcel(r.unitPriceNoBDIWithDiscount), FMT_BRL, rowFill),
        nCell(pctExcel((bdi || 0) / 100), FMT_PCT, rowFill),
        nCell(moneyExcel(r.unitPriceWithBDI), FMT_BRL, rowFill),
        nCell(moneyExcel(r.valorAcrescido), FMT_BRL, COLOR.acrescidoBg, COLOR.acrescidoFg),
        nCell(moneyExcel(r.valorFinal), FMT_BRL, rowFill),
        tCell(obs, rowFill),
      ]);
      rowHeights.push(estimateRowHeight(c.description || ''));
      totAcr = trunc2(totAcr + r.valorAcrescido);
      totFinal = trunc2(totFinal + r.valorFinal);
    },
    onOrphanStart: () => {
      const r0 = rows.length;
      rows.push([{ v: 'Sem capítulo (não vinculado à EAP)', s: { font: { bold: true } } }, ...Array(totalCols - 1).fill('')]);
      merges.push({ s: { r: r0, c: 0 }, e: { r: r0, c: totalCols - 1 } });
      rowHeights.push(18);
    },
  });

  const fillT = COLOR.totalGeralBg, fgT = COLOR.totalGeralFg;
  const totalRowIdx = rows.length;
  rows.push([
    tCell('TOTAL NOVAS COMPOSIÇÕES', fillT, true, fgT, 'left'),
    ...Array(10).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: fillT } } } }),
    nCell(moneyExcel(totAcr), FMT_BRL, COLOR.acrescidoBg, COLOR.acrescidoFg, true),
    nCell(moneyExcel(totFinal), FMT_BRL, fillT, fgT, true),
    tCell('', fillT),
  ]);
  merges.push({ s: { r: totalRowIdx, c: 0 }, e: { r: totalRowIdx, c: 10 } });
  rowHeights.push(24);

  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(c => (c && typeof c === 'object') ? (c as any).v : c)));
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
    const cell = rows[r][c];
    if (cell && typeof cell === 'object') ws[XLSX.utils.encode_cell({ r, c })] = cell;
  }
  ws['!cols'] = [
    { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 38 }, { wch: 6 },
    { wch: 12 },
    { wch: 14 }, { wch: 11 }, { wch: 16 }, { wch: 8 }, { wch: 13 },
    { wch: 14 }, { wch: 14 },
    { wch: 22 },
  ];
  ws['!merges'] = merges;
  ws['!rows'] = rowHeights.map(h => ({ hpt: h }));
  const subHeaderRowIdx = hdr.rows.length + 1;
  const firstDataRowIdx = subHeaderRowIdx + 1;
  (ws as any)['!views'] = [{ state: 'frozen', ySplit: firstDataRowIdx }];
  const lastRowIdx = rows.length - 1;
  ws['!autofilter'] = {
    ref: `${XLSX.utils.encode_cell({ r: subHeaderRowIdx, c: 0 })}:${XLSX.utils.encode_cell({ r: lastRowIdx, c: totalCols - 1 })}`,
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Novas Composições');
  downloadXlsxBlob(XLSX, wb, `aditivo_novas_composicoes_${safeFile(add.name)}.xlsx`);
}

// ---------- Exportador 3: Memória de Cálculo (Excel) ----------
export async function exportAdditiveCalculationMemoryPro(project: Project, add: Additive) {
  const XLSX = await loadXLSXStyle();

  const totalCols = 9; // memória usa 9 colunas
  const rows: Row[] = [];
  const merges: any[] = [];
  const rowHeights: number[] = [];

  const hdr = buildFormalHeaderBlock(project, add, 'ADITIVO — MEMÓRIA DE CÁLCULO', totalCols, null);
  rows.push(...hdr.rows); merges.push(...hdr.merges); rowHeights.push(...hdr.rowHeights);

  const filterFn = (c: AdditiveComposition) => {
    const sup = c.suppressedQuantity ?? 0;
    const acr = c.addedQuantity ?? 0;
    const hasMem = validMemoryRows(c.calculationMemory).length > 0;
    return !!c.isNewService || sup > 0 || acr > 0 || hasMem;
  };

  let grandAcr = 0, grandSup = 0;

  const pushIdent = (c: AdditiveComposition) => {
    // Linha 1: cabeçalho de identificação (com cor de coluna sup/acr)
    const idHead = ['Item', 'Código', 'Banco', 'Descrição', 'Und', 'Qtd Contrat.', 'Qtd Suprim.', 'Qtd Acresc.', 'Qtd Final'];
    const idHeadFills = [
      COLOR.qtyHead, COLOR.qtyHead, COLOR.qtyHead, COLOR.qtyHead, COLOR.qtyHead,
      COLOR.qtyHead, COLOR.suprimidoBg, COLOR.acrescidoBg, COLOR.qtyHead,
    ];
    const idHeadFg = [
      '0F172A', '0F172A', '0F172A', '0F172A', '0F172A',
      '0F172A', COLOR.suprimidoFg, COLOR.acrescidoFg, '0F172A',
    ];
    rows.push(idHead.map((h, i) => ({
      v: h,
      s: {
        font: { name: 'Arial', sz: 9, bold: true, color: { rgb: idHeadFg[i] } },
        alignment: { vertical: 'center', horizontal: 'center', wrapText: true },
        fill: { patternType: 'solid', fgColor: { rgb: idHeadFills[i] } },
        border: {
          top: { style: 'thin', color: { rgb: COLOR.border } },
          bottom: { style: 'thin', color: { rgb: COLOR.border } },
          left: { style: 'thin', color: { rgb: COLOR.border } },
          right: { style: 'thin', color: { rgb: COLOR.border } },
        },
      },
    })));
    rowHeights.push(20);
    const fillRow = c.isNewService ? COLOR.novoServico : COLOR.itemAlterado;
    rows.push([
      tCell(c.item || '', fillRow),
      tCell(c.code || '', fillRow),
      tCell(c.bank || '', fillRow),
      tCell(c.description || '', fillRow),
      tCell(c.unit || '', fillRow, false, undefined, 'center'),
      nCell(q2(c.originalQuantity ?? 0), FMT_QTD, fillRow),
      nCell(q2(c.suppressedQuantity ?? 0), FMT_QTD, COLOR.suprimidoBg, COLOR.suprimidoFg),
      nCell(q2(c.addedQuantity ?? 0), FMT_QTD, COLOR.acrescidoBg, COLOR.acrescidoFg),
      nCell(q2(totalAfterAdditive(c)), FMT_QTD, fillRow),
    ]);
    rowHeights.push(estimateRowHeight(c.description || ''));
  };

  const pushMemHead = (c: AdditiveComposition) => {
    const labels = resolveMemoryColumnLabels(c.calculationMemoryColumns);
    const mh = ['Loc', 'Tipo', 'Comentário', 'Fórmula', labels.a, labels.b, labels.c, labels.d, 'Parcial'];
    rows.push(mh.map(h => ({
      v: h,
      s: {
        font: { name: 'Arial', sz: 9, bold: true, color: { rgb: 'FFFFFF' } },
        alignment: { vertical: 'center', horizontal: 'center', wrapText: true },
        fill: { patternType: 'solid', fgColor: { rgb: COLOR.headerBlack } },
        border: {
          top: { style: 'thin', color: { rgb: COLOR.border } },
          bottom: { style: 'thin', color: { rgb: COLOR.border } },
          left: { style: 'thin', color: { rgb: COLOR.border } },
          right: { style: 'thin', color: { rgb: COLOR.border } },
        },
      },
    })));
    rowHeights.push(22);
  };

  walkByChapters(project, add, filterFn, {
    onChapterStart: ch => {
      const r0 = rows.length;
      rows.push([{
        v: `${'    '.repeat(ch.depth)}${ch.number} ${ch.name}`,
        s: {
          font: { name: 'Arial', sz: 10, bold: true },
          alignment: { vertical: 'center', horizontal: 'left' },
          fill: { patternType: 'solid', fgColor: { rgb: COLOR.chapter } },
        },
      }, ...Array(totalCols - 1).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: COLOR.chapter } } } })]);
      merges.push({ s: { r: r0, c: 0 }, e: { r: r0, c: totalCols - 1 } });
      rowHeights.push(20);
    },
    onComposition: c => {
      pushIdent(c);
      pushMemHead(c);
      const list = validMemoryRows(c.calculationMemory);
      if (list.length === 0) {
        rows.push([
          tCell('—', undefined, false, undefined, 'center'),
          tCell('—'),
          tCell('Sem memória de cálculo preenchida'),
          tCell(''), tCell(''), tCell(''), tCell(''), tCell(''), tCell(''),
        ]);
        rowHeights.push(18);
      } else {
        let totA = 0, totS = 0;
        list.forEach((m, idx) => {
          const partial = Number.isFinite(m.partial) ? m.partial : 0;
          const isSup = m.type === 'suprimida';
          const fill = isSup ? COLOR.suprimidoBg : COLOR.acrescidoBg;
          const fg = isSup ? COLOR.suprimidoFg : COLOR.acrescidoFg;
          rows.push([
            tCell(idx + 1, undefined, false, undefined, 'center'),
            tCell(isSup ? 'Suprimida' : 'Acrescida', fill, true, fg, 'center'),
            tCell(m.comment ?? ''),
            tCell(m.formula ?? '', undefined, false, undefined, 'left'),
            tCell(m.a ?? '', undefined, false, undefined, 'right'),
            tCell(m.b ?? '', undefined, false, undefined, 'right'),
            tCell(m.c ?? '', undefined, false, undefined, 'right'),
            tCell(m.d ?? '', undefined, false, undefined, 'right'),
            nCell(q2(partial), FMT_QTD, fill, fg, true),
          ]);
          rowHeights.push(18);
          if (isSup) totS += partial; else totA += partial;
        });
        const rA = rows.length;
        rows.push([
          tCell('Total Acrescida', COLOR.subtotal, true, COLOR.acrescidoFg, 'right'),
          ...Array(7).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: COLOR.subtotal } } } }),
          nCell(q2(totA), FMT_QTD, COLOR.subtotal, COLOR.acrescidoFg, true),
        ]);
        merges.push({ s: { r: rA, c: 0 }, e: { r: rA, c: 7 } });
        rowHeights.push(18);
        const rS = rows.length;
        rows.push([
          tCell('Total Suprimida', COLOR.subtotal, true, COLOR.suprimidoFg, 'right'),
          ...Array(7).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: COLOR.subtotal } } } }),
          nCell(q2(totS), FMT_QTD, COLOR.subtotal, COLOR.suprimidoFg, true),
        ]);
        merges.push({ s: { r: rS, c: 0 }, e: { r: rS, c: 7 } });
        rowHeights.push(18);
        grandAcr = trunc2(grandAcr + totA);
        grandSup = trunc2(grandSup + totS);
      }
      // separador
      rows.push(Array(totalCols).fill(''));
      rowHeights.push(6);
    },
    onOrphanStart: () => {
      const r0 = rows.length;
      rows.push([{ v: 'Sem capítulo (não vinculado à EAP)', s: { font: { bold: true } } }, ...Array(totalCols - 1).fill('')]);
      merges.push({ s: { r: r0, c: 0 }, e: { r: r0, c: totalCols - 1 } });
      rowHeights.push(18);
    },
  });

  const fillT = COLOR.totalGeralBg, fgT = COLOR.totalGeralFg;
  const rGA = rows.length;
  rows.push([
    tCell('TOTAL GERAL ACRESCIDO', fillT, true, fgT, 'right'),
    ...Array(7).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: fillT } } } }),
    nCell(q2(grandAcr), FMT_QTD, fillT, fgT, true),
  ]);
  merges.push({ s: { r: rGA, c: 0 }, e: { r: rGA, c: 7 } });
  rowHeights.push(22);
  const rGS = rows.length;
  rows.push([
    tCell('TOTAL GERAL SUPRIMIDO', fillT, true, fgT, 'right'),
    ...Array(7).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: fillT } } } }),
    nCell(q2(grandSup), FMT_QTD, fillT, fgT, true),
  ]);
  merges.push({ s: { r: rGS, c: 0 }, e: { r: rGS, c: 7 } });
  rowHeights.push(22);
  const rDL = rows.length;
  rows.push([
    tCell('DIFERENÇA LÍQUIDA', fillT, true, fgT, 'right'),
    ...Array(7).fill({ v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: fillT } } } }),
    nCell(q2(grandAcr - grandSup), FMT_QTD, fillT, fgT, true),
  ]);
  merges.push({ s: { r: rDL, c: 0 }, e: { r: rDL, c: 7 } });
  rowHeights.push(22);

  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(c => (c && typeof c === 'object') ? (c as any).v : c)));
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
    const cell = rows[r][c];
    if (cell && typeof cell === 'object') ws[XLSX.utils.encode_cell({ r, c })] = cell;
  }
  ws['!cols'] = [
    { wch: 6 }, { wch: 12 }, { wch: 32 }, { wch: 22 },
    { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 12 },
  ];
  ws['!merges'] = merges;
  ws['!rows'] = rowHeights.map(h => ({ hpt: h }));
  const subFreeze = hdr.rows.length + 1;
  (ws as any)['!views'] = [{ state: 'frozen', ySplit: subFreeze }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Memória de Cálculo');
  downloadXlsxBlob(XLSX, wb, `aditivo_memoria_calculo_${safeFile(add.name)}.xlsx`);
}

// ============================================================
// PDF (jsPDF + autoTable)
// ============================================================

async function loadPdf() {
  const [jsPDFMod, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const jsPDF = (jsPDFMod as any).default || (jsPDFMod as any).jsPDF || jsPDFMod;
  const autoTable = (autoTableMod as any).default || (autoTableMod as any).autoTable || autoTableMod;
  return { jsPDF, autoTable };
}

async function drawPdfFormalHeader(
  doc: any,
  autoTable: any,
  project: Project,
  add: Additive,
  reportTitle: string,
): Promise<number> {
  const margin = 6;
  const pageWidth = doc.internal.pageSize.getWidth();
  const usable = pageWidth - margin * 2;
  const ci = project.contractInfo || {};

  const logo = await loadCompanyLogoForPdf().catch(() => null);
  const logoTargetW = 30;
  let logoH = 0;
  if (logo) {
    const ratio = logo.width / logo.height;
    logoH = logoTargetW / ratio;
    try { doc.addImage(logo.dataUrl, 'PNG', margin, margin, logoTargetW, logoH, undefined, 'FAST'); } catch {}
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(60);
  doc.text(company.name, pageWidth / 2, margin + 4, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`${company.legalName} · CNPJ ${company.cnpj}`, pageWidth / 2, margin + 8, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text(reportTitle.toUpperCase(), pageWidth / 2, margin + 14, { align: 'center' });

  let cursorY = Math.max(margin + 16, margin + logoH + 1);

  const cw = [usable * 0.16, usable * 0.34, usable * 0.16, usable * 0.34];
  const issueStr = fmtDateBR(add.headerIssueDate || new Date());
  const headerRows: [string, string, string, string][] = [
    ['Obra:', project.name || '-', 'Aditivo:', add.name || '-'],
    ['Contratante:', ci.contractor || '-', 'Contratada:', ci.contracted || '-'],
    ['Local/Município:', ci.location || '-', 'Objeto:', ci.contractObject || '-'],
    ['Nº Contrato:', ci.contractNumber || '-', 'Nº ART:', ci.artNumber || '-'],
    ['Fonte de orçamento:', ci.budgetSource || '-', 'Status:', statusLabel(add.status)],
    ['BDI %:', `${(add.bdiPercent ?? 0).toFixed(2)}`, 'Desconto Licit. %:', `${(add.globalDiscountPercent ?? 0).toFixed(2)}`],
    ['Data emissão:', issueStr, 'Responsável:', add.headerResponsible || add.approvedBy || '-'],
  ];
  autoTable(doc, {
    startY: cursorY, body: headerRows, theme: 'grid',
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.4, valign: 'middle', lineColor: [180, 180, 180], lineWidth: 0.15, textColor: 20 },
    columnStyles: {
      0: { cellWidth: cw[0], fontStyle: 'bold', fillColor: [241, 245, 249] },
      1: { cellWidth: cw[1] },
      2: { cellWidth: cw[2], fontStyle: 'bold', fillColor: [241, 245, 249] },
      3: { cellWidth: cw[3] },
    },
    margin: { left: margin, right: margin },
    tableWidth: usable,
  });
  return ((doc as any).lastAutoTable?.finalY ?? cursorY) + 3;
}

function pdfFooter(doc: any) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(120);
    doc.text(`${company.name} · ${company.cnpj} · ${company.city}`, pageWidth / 2, pageH - 5, { align: 'center' });
    doc.text(`Pág. ${p}/${pageCount}`, pageWidth - 6, pageH - 5, { align: 'right' });
  }
}

const fmtBRL = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtQ = (v: number) => (Number.isFinite(v) ? v : 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPctBR = (v: number) => `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

// ---- PDF Sintética Completa ----
export async function exportAdditiveSyntheticCompletePdf(project: Project, add: Additive) {
  const { jsPDF, autoTable } = await loadPdf();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const margin = 6;
  let cursorY = await drawPdfFormalHeader(doc, autoTable, project, add, 'Aditivo — Sintética Completa');

  const bdi = add.bdiPercent ?? 0;
  const discount = add.globalDiscountPercent ?? 0;

  const head = [
    [
      { content: 'IDENTIFICAÇÃO', colSpan: 5, styles: { halign: 'center', fillColor: [226, 232, 240], textColor: 15 } },
      { content: 'QUANTIDADES', colSpan: 4, styles: { halign: 'center', fillColor: [191, 219, 254], textColor: 15 } },
      { content: 'VALORES', colSpan: 2, styles: { halign: 'center', fillColor: [219, 234, 254], textColor: 15 } },
      { content: 'IMPACTO DO ADITIVO', colSpan: 5, styles: { halign: 'center', fillColor: [167, 243, 208], textColor: 15 } },
    ],
    ['Item', 'Cód', 'Banco', 'Descrição', 'Und',
      'Q.Cont.', 'Q.Sup.', 'Q.Acr.', 'Q.Final',
      'V.Unit s/BDI', 'V.Unit c/BDI',
      'V.Suprim.', 'V.Acresc.', 'V.Final', 'Diferença', '% Var.'],
  ];
  const body: any[] = [];

  walkByChapters(project, add, () => true, {
    onChapterStart: ch => {
      body.push([{
        content: `${'    '.repeat(ch.depth)}${ch.number} ${ch.name}`,
        colSpan: 16,
        styles: { fillColor: [241, 245, 249], fontStyle: 'bold', textColor: 15 },
      }]);
    },
    onComposition: c => {
      const r = computeAdditiveRow(c, bdi, discount);
      const rowFill: [number, number, number] | undefined = c.isNewService
        ? [239, 246, 255]
        : ((c.suppressedQuantity ?? 0) > 0 || (c.addedQuantity ?? 0) > 0) ? [254, 249, 195] : undefined;
      const supStyles = (c.suppressedQuantity ?? 0) > 0
        ? { fillColor: [254, 226, 226] as [number, number, number], textColor: [185, 28, 28] as [number, number, number] }
        : (rowFill ? { fillColor: rowFill } : {});
      const acrStyles = (c.addedQuantity ?? 0) > 0
        ? { fillColor: [220, 252, 231] as [number, number, number], textColor: [4, 120, 87] as [number, number, number] }
        : (rowFill ? { fillColor: rowFill } : {});
      const baseStyles = rowFill ? { fillColor: rowFill } : {};
      body.push([
        { content: c.item || '', styles: baseStyles },
        { content: c.code || '', styles: baseStyles },
        { content: c.bank || '', styles: baseStyles },
        { content: c.description || '', styles: baseStyles },
        { content: c.unit || '', styles: { ...baseStyles, halign: 'center' } },
        { content: fmtQ(r.qtdContratada), styles: { ...baseStyles, halign: 'right' } },
        { content: fmtQ(r.qtdSuprimida), styles: { ...supStyles, halign: 'right' } },
        { content: fmtQ(r.qtdAcrescida), styles: { ...acrStyles, halign: 'right' } },
        { content: fmtQ(r.qtdFinal), styles: { ...baseStyles, halign: 'right' } },
        { content: fmtBRL(r.unitPriceNoBDI), styles: { ...baseStyles, halign: 'right' } },
        { content: fmtBRL(r.unitPriceWithBDI), styles: { ...baseStyles, halign: 'right' } },
        { content: fmtBRL(r.valorSuprimido), styles: { ...supStyles, halign: 'right' } },
        { content: fmtBRL(r.valorAcrescido), styles: { ...acrStyles, halign: 'right' } },
        { content: fmtBRL(r.valorFinal), styles: { ...baseStyles, halign: 'right' } },
        { content: fmtBRL(r.diferenca), styles: { ...baseStyles, halign: 'right' } },
        { content: fmtPctBR(r.percentVar), styles: { ...baseStyles, halign: 'right' } },
      ]);
    },
    onChapterEnd: (ch, descendants) => {
      let sSup = 0, sAcr = 0, sFinal = 0, sDif = 0;
      descendants.forEach(c => {
        const r = computeAdditiveRow(c, bdi, discount);
        sSup += r.valorSuprimido; sAcr += r.valorAcrescido;
        sFinal += r.valorFinal; sDif += r.diferenca;
      });
      body.push([
        { content: `${'    '.repeat(ch.depth)}Subtotal ${ch.number} ${ch.name}`, colSpan: 11, styles: { fillColor: [229, 231, 235], fontStyle: 'bold' } },
        { content: fmtBRL(sSup), styles: { fillColor: [229, 231, 235], fontStyle: 'bold', halign: 'right', textColor: [185, 28, 28] } },
        { content: fmtBRL(sAcr), styles: { fillColor: [229, 231, 235], fontStyle: 'bold', halign: 'right', textColor: [4, 120, 87] } },
        { content: fmtBRL(sFinal), styles: { fillColor: [229, 231, 235], fontStyle: 'bold', halign: 'right' } },
        { content: fmtBRL(sDif), styles: { fillColor: [229, 231, 235], fontStyle: 'bold', halign: 'right' } },
        { content: '', styles: { fillColor: [229, 231, 235] } },
      ]);
    },
  });

  const t = additiveTotals(add, project);
  body.push([
    { content: 'TOTAL GERAL', colSpan: 11, styles: { fillColor: [31, 41, 55], textColor: [255, 255, 255], fontStyle: 'bold' } },
    { content: fmtBRL(t.totalSuprimido), styles: { fillColor: [31, 41, 55], textColor: [255, 255, 255], fontStyle: 'bold', halign: 'right' } },
    { content: fmtBRL(t.totalAcrescido), styles: { fillColor: [31, 41, 55], textColor: [255, 255, 255], fontStyle: 'bold', halign: 'right' } },
    { content: fmtBRL(t.valorFinal), styles: { fillColor: [31, 41, 55], textColor: [255, 255, 255], fontStyle: 'bold', halign: 'right' } },
    { content: fmtBRL(t.diferencaLiquida), styles: { fillColor: [31, 41, 55], textColor: [255, 255, 255], fontStyle: 'bold', halign: 'right' } },
    { content: fmtPctBR(t.percentVariacaoLiquida), styles: { fillColor: [31, 41, 55], textColor: [255, 255, 255], fontStyle: 'bold', halign: 'right' } },
  ]);

  autoTable(doc, {
    startY: cursorY, head, body,
    margin: { left: margin, right: margin },
    styles: { fontSize: 6.4, cellPadding: 0.9, overflow: 'linebreak', lineColor: [200, 200, 200], lineWidth: 0.1 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontSize: 7, halign: 'center' },
    columnStyles: { 3: { cellWidth: 'auto' } },
    didDrawPage: () => {/* footer added later */},
  });

  pdfFooter(doc);
  downloadPdfBlob(doc, `aditivo_sintetica_completa_${safeFile(add.name)}.pdf`);
}

// ---- PDF Novas Composições ----
export async function exportAdditiveNewServicesPdf(project: Project, add: Additive) {
  const { jsPDF, autoTable } = await loadPdf();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const margin = 6;
  let cursorY = await drawPdfFormalHeader(doc, autoTable, project, add, 'Aditivo — Novas Composições');

  const bdi = add.bdiPercent ?? 0;
  const discount = add.globalDiscountPercent ?? 0;

  const head = [[
    'Item', 'Cód', 'Banco', 'Descrição', 'Und',
    'Qtd Acresc.',
    'V.Unit Ref. s/BDI', 'Desc.%', 'V.Unit s/BDI c/Desc.', 'BDI %', 'V.Unit c/BDI',
    'V. Acrescido', 'V. Final', 'Fonte/Obs',
  ]];
  const body: any[] = [];
  let totAcr = 0, totFinal = 0;
  walkByChapters(project, add, c => !!c.isNewService, {
    onChapterStart: ch => body.push([{ content: `${'    '.repeat(ch.depth)}${ch.number} ${ch.name}`, colSpan: 14, styles: { fillColor: [241, 245, 249], fontStyle: 'bold' } }]),
    onComposition: c => {
      const r = computeAdditiveRow(c, bdi, discount);
      const refUnit = referenceUnitNoBDIForNewService(c);
      const obs = c.bank ? `Fonte: ${c.bank}` : 'Novo serviço aditivado';
      const fill: [number, number, number] = [239, 246, 255];
      const acrStyles = { fillColor: [220, 252, 231] as [number, number, number], textColor: [4, 120, 87] as [number, number, number], halign: 'right' as const };
      body.push([
        { content: c.item || '', styles: { fillColor: fill } },
        { content: c.code || '', styles: { fillColor: fill } },
        { content: c.bank || '', styles: { fillColor: fill } },
        { content: c.description || '', styles: { fillColor: fill } },
        { content: c.unit || '', styles: { fillColor: fill, halign: 'center' } },
        { content: fmtQ(r.qtdAcrescida), styles: acrStyles },
        { content: fmtBRL(refUnit), styles: { fillColor: fill, halign: 'right' } },
        { content: `${(discount || 0).toFixed(2)}%`, styles: { fillColor: fill, halign: 'right' } },
        { content: fmtBRL(r.unitPriceNoBDIWithDiscount), styles: { fillColor: fill, halign: 'right' } },
        { content: `${(bdi || 0).toFixed(2)}%`, styles: { fillColor: fill, halign: 'right' } },
        { content: fmtBRL(r.unitPriceWithBDI), styles: { fillColor: fill, halign: 'right' } },
        { content: fmtBRL(r.valorAcrescido), styles: acrStyles },
        { content: fmtBRL(r.valorFinal), styles: { fillColor: fill, halign: 'right' } },
        { content: obs, styles: { fillColor: fill } },
      ]);
      totAcr += r.valorAcrescido; totFinal += r.valorFinal;
    },
  });
  body.push([
    { content: 'TOTAL NOVAS COMPOSIÇÕES', colSpan: 11, styles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold' } },
    { content: fmtBRL(money2(totAcr)), styles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold', halign: 'right' } },
    { content: fmtBRL(money2(totFinal)), styles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold', halign: 'right' } },
    { content: '', styles: { fillColor: [31, 41, 55] } },
  ]);

  autoTable(doc, {
    startY: cursorY, head, body,
    margin: { left: margin, right: margin },
    styles: { fontSize: 6.6, cellPadding: 1, overflow: 'linebreak', lineColor: [200, 200, 200], lineWidth: 0.1 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontSize: 7, halign: 'center' },
    columnStyles: { 3: { cellWidth: 'auto' } },
  });

  pdfFooter(doc);
  downloadPdfBlob(doc, `aditivo_novas_composicoes_${safeFile(add.name)}.pdf`);
}

// ---- PDF Memória de Cálculo ----
export async function exportAdditiveCalculationMemoryPdf(project: Project, add: Additive) {
  const { jsPDF, autoTable } = await loadPdf();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const margin = 6;
  let cursorY = await drawPdfFormalHeader(doc, autoTable, project, add, 'Aditivo — Memória de Cálculo');
  const pageH = doc.internal.pageSize.getHeight();

  const filterFn = (c: AdditiveComposition) => {
    const sup = c.suppressedQuantity ?? 0;
    const acr = c.addedQuantity ?? 0;
    const hasMem = validMemoryRows(c.calculationMemory).length > 0;
    return !!c.isNewService || sup > 0 || acr > 0 || hasMem;
  };

  let grandAcr = 0, grandSup = 0;

  walkByChapters(project, add, filterFn, {
    onChapterStart: ch => {
      if (cursorY > pageH - 30) { doc.addPage(); cursorY = margin; }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(15);
      doc.text(`${'    '.repeat(ch.depth)}${ch.number} ${ch.name}`, margin, cursorY + 4);
      cursorY += 6;
    },
    onComposition: c => {
      // bloco identificação
      autoTable(doc, {
        startY: cursorY,
        head: [['Item', 'Código', 'Banco', 'Descrição', 'Und', 'Q.Cont.', 'Q.Sup.', 'Q.Acr.', 'Q.Final']],
        body: [[
          c.item || '', c.code || '', c.bank || '', c.description || '', c.unit || '',
          fmtQ(c.originalQuantity ?? 0),
          { content: fmtQ(c.suppressedQuantity ?? 0), styles: (c.suppressedQuantity ?? 0) > 0 ? { fillColor: [254, 226, 226], textColor: [185, 28, 28] } : {} },
          { content: fmtQ(c.addedQuantity ?? 0), styles: (c.addedQuantity ?? 0) > 0 ? { fillColor: [220, 252, 231], textColor: [4, 120, 87] } : {} },
          fmtQ(totalAfterAdditive(c)),
        ]],
        margin: { left: margin, right: margin },
        styles: { fontSize: 7, cellPadding: 1.2, lineColor: [200, 200, 200], lineWidth: 0.1 },
        headStyles: { fillColor: [191, 219, 254], textColor: 15, fontSize: 7, halign: 'center' },
        columnStyles: { 3: { cellWidth: 'auto' } },
      });
      cursorY = (doc as any).lastAutoTable.finalY + 1;

      const list = validMemoryRows(c.calculationMemory);
      const labels = resolveMemoryColumnLabels(c.calculationMemoryColumns);
      let totA = 0, totS = 0;
      const memBody: any[] = list.length === 0
        ? [['—', '—', 'Sem memória de cálculo preenchida', '', '', '', '', '', '']]
        : list.map((m, idx) => {
          const partial = Number.isFinite(m.partial) ? m.partial : 0;
          const isSup = m.type === 'suprimida';
          if (isSup) totS += partial; else totA += partial;
          const styles = isSup
            ? { fillColor: [254, 226, 226] as [number, number, number], textColor: [185, 28, 28] as [number, number, number] }
            : { fillColor: [220, 252, 231] as [number, number, number], textColor: [4, 120, 87] as [number, number, number] };
          return [
            { content: idx + 1, styles: { halign: 'center' } },
            { content: isSup ? 'Suprimida' : 'Acrescida', styles: { ...styles, halign: 'center', fontStyle: 'bold' } },
            m.comment ?? '',
            m.formula ?? '',
            { content: m.a ?? '', styles: { halign: 'right' } },
            { content: m.b ?? '', styles: { halign: 'right' } },
            { content: m.c ?? '', styles: { halign: 'right' } },
            { content: m.d ?? '', styles: { halign: 'right' } },
            { content: fmtQ(partial), styles: { ...styles, halign: 'right', fontStyle: 'bold' } },
          ];
        });
      if (list.length > 0) {
        memBody.push([
          { content: 'Total Acrescida', colSpan: 8, styles: { fillColor: [229, 231, 235], fontStyle: 'bold', textColor: [4, 120, 87], halign: 'right' } },
          { content: fmtQ(totA), styles: { fillColor: [229, 231, 235], fontStyle: 'bold', textColor: [4, 120, 87], halign: 'right' } },
        ]);
        memBody.push([
          { content: 'Total Suprimida', colSpan: 8, styles: { fillColor: [229, 231, 235], fontStyle: 'bold', textColor: [185, 28, 28], halign: 'right' } },
          { content: fmtQ(totS), styles: { fillColor: [229, 231, 235], fontStyle: 'bold', textColor: [185, 28, 28], halign: 'right' } },
        ]);
        grandAcr += totA; grandSup += totS;
      }
      autoTable(doc, {
        startY: cursorY,
        head: [['Loc', 'Tipo', 'Comentário', 'Fórmula', labels.a, labels.b, labels.c, labels.d, 'Parcial']],
        body: memBody,
        margin: { left: margin + 4, right: margin },
        styles: { fontSize: 6.8, cellPadding: 1, lineColor: [200, 200, 200], lineWidth: 0.1 },
        headStyles: { fillColor: [30, 41, 59], textColor: 255, fontSize: 7 },
        columnStyles: { 2: { cellWidth: 'auto' } },
      });
      cursorY = (doc as any).lastAutoTable.finalY + 4;
      if (cursorY > pageH - 25) { doc.addPage(); cursorY = margin; }
    },
  });

  // Totais finais
  if (cursorY > pageH - 30) { doc.addPage(); cursorY = margin; }
  autoTable(doc, {
    startY: cursorY,
    body: [
      [{ content: 'TOTAL GERAL ACRESCIDO', styles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold' } }, { content: fmtQ(money2(grandAcr)), styles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold', halign: 'right' } }],
      [{ content: 'TOTAL GERAL SUPRIMIDO', styles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold' } }, { content: fmtQ(money2(grandSup)), styles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold', halign: 'right' } }],
      [{ content: 'DIFERENÇA LÍQUIDA', styles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold' } }, { content: fmtQ(money2(grandAcr - grandSup)), styles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold', halign: 'right' } }],
    ],
    margin: { left: margin, right: margin },
    styles: { fontSize: 9, cellPadding: 2 },
    columnStyles: { 0: { cellWidth: 80 }, 1: { cellWidth: 60 } },
  });

  pdfFooter(doc);
  downloadPdfBlob(doc, `aditivo_memoria_calculo_${safeFile(add.name)}.pdf`);
}
