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

function findCell(cells: CellInfo[], row: number, col: number): HTMLElement | null {
  return cells.find(c => c.row === row && c.col === col)?.el ?? null;
}

function findInCol(cells: CellInfo[], _idx: number, row: number, col: number, dir: 1 | -1): HTMLElement | null {
  // Mesma coluna, linha mais próxima na direção informada (sem fallback DOM,
  // para não pular para colunas erradas durante ArrowUp/ArrowDown).
  const sameCol = cells
    .filter(c => c.col === col && (dir === 1 ? c.row > row : c.row < row))
    .sort((a, b) => dir === 1 ? a.row - b.row : b.row - a.row);
  return sameCol[0]?.el ?? null;
}

function focusCell(el: HTMLElement) {
  try {
    el.focus({ preventScroll: true });
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

  // A partir daqui, o evento pertence à grade. Sempre bloqueia o default
  // (impede scroll da página) e a propagação, mesmo quando não houver destino.
  e.preventDefault();
  e.stopPropagation();

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
    focusCell(target);
  }
  // Sem destino: mantém foco atual; default já foi prevenido.
}

export function handleGridContainerKeyDownCapture(e: React.KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  const cell = target.closest(`[${ATTR_GRID}][${ATTR_ROW}][${ATTR_COL}]`) as HTMLElement | null;
  if (!cell) return;

  const gridId = cell.getAttribute(ATTR_GRID);
  const row = Number(cell.getAttribute(ATTR_ROW));
  const col = Number(cell.getAttribute(ATTR_COL));

  if (!gridId || !Number.isFinite(row) || !Number.isFinite(col)) return;

  const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab'];
  if (!keys.includes(e.key)) return;

  e.preventDefault();
  e.stopPropagation();

  const cells = getCells(gridId)
    .sort((a, b) => a.row - b.row || a.col - b.col);

  if (cells.length === 0) return;

  let nextRow = row;
  let nextCol = col;

  if (e.key === 'ArrowUp') nextRow = row - 1;
  if (e.key === 'ArrowDown') nextRow = row + 1;
  if (e.key === 'ArrowLeft') nextCol = col - 1;
  if (e.key === 'ArrowRight') nextCol = col + 1;

  if (e.key === 'Enter' || e.key === 'Tab') {
    nextCol = e.shiftKey ? col - 1 : col + 1;
  }

  const cols = [...new Set(cells.map(c => c.col))].sort((a, b) => a - b);
  const rows = [...new Set(cells.map(c => c.row))].sort((a, b) => a - b);
  const minCol = cols[0] ?? 0;
  const maxCol = cols[cols.length - 1] ?? 0;
  const minRow = rows[0] ?? 0;
  const maxRow = rows[rows.length - 1] ?? 0;

  if (nextCol > maxCol) {
    nextCol = minCol;
    nextRow = row + 1;
  }

  if (nextCol < minCol) {
    nextCol = maxCol;
    nextRow = row - 1;
  }

  if (nextRow < minRow) nextRow = minRow;
  if (nextRow > maxRow) nextRow = maxRow;

  let next = findCell(cells, nextRow, nextCol);

  if (!next) {
    const sameRow = cells.filter(c => c.row === nextRow);
    next = sameRow
      .sort((a, b) => Math.abs(a.col - nextCol) - Math.abs(b.col - nextCol))[0]?.el ?? null;
  }

  if (next) focusCell(next);
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

/* ------------------------------------------------------------------ *
 * Trava global em capture-phase: enquanto o foco estiver numa célula
 * com [data-grid-id] (ou dentro de uma), as teclas de navegação NUNCA
 * podem rolar a página. Roda antes dos handlers React, então funciona
 * mesmo que algum componente esqueça de chamar preventDefault.
 * ------------------------------------------------------------------ */
const SCROLL_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar',
]);

function isInGridCell(el: EventTarget | null): HTMLElement | null {
  if (!el || !(el instanceof HTMLElement)) return null;
  if (el.hasAttribute(ATTR_GRID)) return el;
  return el.closest?.(`[${ATTR_GRID}]`) as HTMLElement | null;
}

if (typeof window !== 'undefined' && !(window as any).__gridKeyGuardInstalled) {
  (window as any).__gridKeyGuardInstalled = true;
  window.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key)) return;
      const cell = isInGridCell(e.target);
      if (!cell) return;
      const target = e.target as HTMLElement;
      // Em inputs/textarea de texto, NÃO bloqueamos ArrowLeft/Right/Home/End/Space
      // — são usadas para mover o cursor dentro do texto e não rolam a página.
      if (isTextLike(target)) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
            || e.key === 'Home' || e.key === 'End'
            || e.key === ' ' || e.key === 'Spacebar') {
          return;
        }
      }
      // ArrowUp/Down/PageUp/PageDown sempre bloqueados na grade — evita scroll.
      // Importante: NÃO chamar stopPropagation aqui, senão o handler React
      // (handleGridKeyDown) não recebe o evento e a navegação vertical quebra.
      e.preventDefault();
    },
    { capture: true },
  );
}
