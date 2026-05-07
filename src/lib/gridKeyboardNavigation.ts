/**
 * Navegação por teclado estilo planilha em grades editáveis.
 *
 * Uso em cada célula editável (Input, textarea, select, etc.):
 *   <Input
 *     data-grid-id="additive-memory-XYZ"
 *     data-row-index={rowIdx}
 *     data-col-index={colIdx}
 *     onKeyDown={handleGridKeyDown}
 *   />
 *
 * - Setas navegam entre células do MESMO gridId.
 * - Enter / Tab e Shift+Enter / Shift+Tab também navegam.
 * - Quando existe célula destino dentro do grid, faz preventDefault + stopPropagation
 *   para impedir que a página role.
 * - ArrowLeft/Right só "saem" da célula de texto se o cursor estiver no início/fim.
 * - Não cria células novas — depende do componente para já renderizar uma linha vazia
 *   final caso queira permitir crescimento (memória / analítica fazem isso).
 */
import type React from 'react';

const ATTR_GRID = 'data-grid-id';
const ATTR_ROW = 'data-row-index';
const ATTR_COL = 'data-col-index';

type CellInfo = { el: HTMLElement; row: number; col: number };

const isTextLike = (el: HTMLElement): boolean => {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'SELECT') return false;
  if (el.tagName !== 'INPUT') return false;
  const t = ((el as HTMLInputElement).type || '').toLowerCase();
  return t === '' || t === 'text' || t === 'search' || t === 'url' || t === 'tel' || t === 'email' || t === 'password';
};

const caretAtStart = (el: HTMLElement) => {
  try {
    const inp = el as HTMLInputElement;
    return (inp.selectionStart ?? 0) === 0 && (inp.selectionEnd ?? 0) === 0;
  } catch { return true; }
};
const caretAtEnd = (el: HTMLElement) => {
  try {
    const inp = el as HTMLInputElement;
    const len = (inp.value ?? '').length;
    return (inp.selectionStart ?? len) === len && (inp.selectionEnd ?? len) === len;
  } catch { return true; }
};

const escapeAttr = (s: string) =>
  (typeof CSS !== 'undefined' && (CSS as any).escape) ? (CSS as any).escape(s) : s.replace(/"/g, '\\"');

function getCells(gridId: string): CellInfo[] {
  const nodes = document.querySelectorAll<HTMLElement>(
    `[${ATTR_GRID}="${escapeAttr(gridId)}"][${ATTR_ROW}][${ATTR_COL}]`,
  );
  const out: CellInfo[] = [];
  nodes.forEach(el => {
    if ((el as HTMLInputElement).disabled) return;
    // Visível?
    if (el.offsetParent === null && el.tagName !== 'TEXTAREA') return;
    const row = Number(el.getAttribute(ATTR_ROW));
    const col = Number(el.getAttribute(ATTR_COL));
    if (Number.isFinite(row) && Number.isFinite(col)) out.push({ el, row, col });
  });
  return out;
}

function findInRow(cells: CellInfo[], idx: number, row: number, col: number, dir: 1 | -1): HTMLElement | null {
  // Mesma linha lógica: cells com mesmo row e col diferente, mais próximo na direção.
  const same = cells.filter(c => c.row === row && c.el !== cells[idx].el);
  const cand = same
    .filter(c => dir === 1 ? c.col > col : c.col < col)
    .sort((a, b) => dir === 1 ? a.col - b.col : b.col - a.col);
  if (cand[0]) return cand[0].el;
  // Fallback: próxima célula em ordem DOM
  const domNext = cells[idx + dir];
  return domNext?.el ?? null;
}

function findInCol(cells: CellInfo[], idx: number, row: number, col: number, dir: 1 | -1): HTMLElement | null {
  // Mesma coluna lógica, próxima/anterior linha em ordem DOM
  const list = dir === 1 ? cells.slice(idx + 1) : cells.slice(0, idx).reverse();
  const sameCol = list.find(c => c.col === col && c.row !== row);
  if (sameCol) return sameCol.el;
  // Fallback: qualquer próxima célula em DOM
  return list[0]?.el ?? null;
}

function focusCell(el: HTMLElement) {
  try {
    el.focus({ preventScroll: false });
  } catch { el.focus(); }
  if ('select' in el) {
    try { (el as HTMLInputElement).select(); } catch { /* noop */ }
  }
}

export function handleGridKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const el = e.currentTarget as HTMLElement;
  const gridId = el.getAttribute(ATTR_GRID);
  const row = Number(el.getAttribute(ATTR_ROW));
  const col = Number(el.getAttribute(ATTR_COL));
  if (!gridId || !Number.isFinite(row) || !Number.isFinite(col)) return;

  const k = e.key;
  if (!['Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) return;

  // Em textarea, Enter deve quebrar linha (não navegar).
  if (k === 'Enter' && el.tagName === 'TEXTAREA' && !e.shiftKey) return;

  // Setas horizontais só "saem" de texto se cursor estiver na borda.
  if (k === 'ArrowRight' && isTextLike(el) && !caretAtEnd(el)) return;
  if (k === 'ArrowLeft' && isTextLike(el) && !caretAtStart(el)) return;

  const cells = getCells(gridId);
  if (cells.length === 0) return;
  const idx = cells.findIndex(c => c.el === el);
  if (idx < 0) return;

  let target: HTMLElement | null = null;
  if (k === 'ArrowDown') target = findInCol(cells, idx, row, col, +1);
  else if (k === 'ArrowUp') target = findInCol(cells, idx, row, col, -1);
  else if (k === 'ArrowRight') target = findInRow(cells, idx, row, col, +1) || findInCol(cells, idx, row, col, +1);
  else if (k === 'ArrowLeft') target = findInRow(cells, idx, row, col, -1) || findInCol(cells, idx, row, col, -1);
  else if (k === 'Enter' || k === 'Tab') {
    const dir: 1 | -1 = e.shiftKey ? -1 : 1;
    target = findInRow(cells, idx, row, col, dir) || findInCol(cells, idx, row, col, dir);
  }

  if (target) {
    e.preventDefault();
    e.stopPropagation();
    focusCell(target);
  } else if (k === 'ArrowUp' || k === 'ArrowDown') {
    // Sem destino: ainda assim não rola a página dentro do grid.
    e.preventDefault();
  }
}

/** Helper para gerar props das células. */
export function gridCellProps(gridId: string, rowIndex: number, colIndex: number) {
  return {
    [ATTR_GRID]: gridId,
    [ATTR_ROW]: rowIndex,
    [ATTR_COL]: colIndex,
    onKeyDown: handleGridKeyDown,
  } as Record<string, unknown>;
}
