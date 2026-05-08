import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Plus, Copy, Trash2, AlertTriangle } from 'lucide-react';
import type {
  AdditiveComposition,
  AdditiveCalculationMemoryRow,
  AdditiveCalculationMemoryColumns,
} from '@/types/project';
import {
  evalMemoryFormula,
  isMemoryRowFilled,
  makeMemoryRow,
  recalcMemoryRow,
  resolveMemoryColumnLabels,
  validMemoryRows,
} from '@/lib/calculationMemory';
import { fmtNum } from './types';

interface Props {
  c: AdditiveComposition;
  isLocked: boolean;
  /** Recebe SOMENTE linhas preenchidas (a linha vazia visual é estado local). */
  onChange: (rows: AdditiveCalculationMemoryRow[]) => void;
  onChangeColumns?: (cols: AdditiveCalculationMemoryColumns) => void;
}

const numOrUndef = (v: string): number | undefined => {
  if (v === '' || v == null) return undefined;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
};

/** Campos editáveis e ordem de navegação. */
const EDIT_FIELDS = ['type', 'comment', 'formula', 'a', 'b', 'c', 'd'] as const;
type EditField = typeof EDIT_FIELDS[number];

/** Cabeçalho editável por duplo clique. */
function EditableHeader({
  value, defaultValue, disabled, onCommit,
}: {
  value: string; defaultValue: string; disabled?: boolean;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select(); });
    }
  }, [editing, value]);

  if (editing && !disabled) {
    return (
      <input
        ref={ref}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); onCommit(draft.trim() || defaultValue); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); setEditing(false); onCommit(draft.trim() || defaultValue); }
          else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        className="h-6 w-full text-[11px] px-1 border border-input rounded bg-background"
      />
    );
  }
  return (
    <span
      onDoubleClick={() => !disabled && setEditing(true)}
      title={disabled ? value : 'Duplo clique para renomear'}
      className={`block w-full select-none ${disabled ? '' : 'cursor-text hover:underline decoration-dotted'}`}
    >
      {value}
    </span>
  );
}

/**
 * Garante exatamente UMA linha vazia ao final.
 * - Remove linhas vazias intermediárias (mantém preenchidas).
 * - Adiciona uma única linha vazia no fim com tipo herdado.
 */
function ensureSingleTrailingDraftRow(
  rows: AdditiveCalculationMemoryRow[],
  preferredType?: 'acrescida' | 'suprimida',
): AdditiveCalculationMemoryRow[] {
  const filled = rows.filter(isMemoryRowFilled);
  const lastType = preferredType
    ?? (filled.length > 0 ? filled[filled.length - 1].type : 'acrescida');
  return [...filled, makeMemoryRow(lastType)];
}

function AdditiveCalculationMemoryImpl({
  c, isLocked, onChange, onChangeColumns,
}: Props) {
  const labels = resolveMemoryColumnLabels(c.calculationMemoryColumns);
  const placeholder = `${labels.a}*${labels.b}*${labels.c}*${labels.d}`;

  /** Linhas persistidas (apenas preenchidas, vindas do projeto). */
  const persistedFilled = useMemo(
    () => validMemoryRows(c.calculationMemory),
    [c.calculationMemory],
  );

  /**
   * ESTADO LOCAL: todas as linhas em edição (preenchidas + 1 vazia no fim).
   * Tudo é alterado livremente em onChange SEM tocar no projeto.
   * O projeto só é atualizado em eventos de confirmação (blur/enter/tab/duplicar/excluir).
   */
  const [rows, setRows] = useState<AdditiveCalculationMemoryRow[]>(
    () => ensureSingleTrailingDraftRow(persistedFilled),
  );

  // Sincroniza quando troca de composição OU quando a versão persistida muda externamente
  // (ex.: troca de aba, recarregar). Só ressincroniza se o conjunto de linhas preenchidas
  // visualmente diferir do que já temos — evita "engolir" digitação local.
  const lastCompIdRef = useRef<string>(c.id);
  useEffect(() => {
    const compChanged = lastCompIdRef.current !== c.id;
    if (compChanged) {
      lastCompIdRef.current = c.id;
      setRows(ensureSingleTrailingDraftRow(persistedFilled));
      return;
    }
    // Mesma composição: reconcilia se difere significativamente.
    const localFilled = rows.filter(isMemoryRowFilled);
    const sameLen = localFilled.length === persistedFilled.length;
    const sameContent = sameLen && localFilled.every((r, i) => {
      const p = persistedFilled[i];
      return p
        && p.id === r.id
        && p.type === r.type
        && (p.comment ?? '') === (r.comment ?? '')
        && (p.formula ?? '') === (r.formula ?? '')
        && (p.a ?? null) === (r.a ?? null)
        && (p.b ?? null) === (r.b ?? null)
        && (p.c ?? null) === (r.c ?? null)
        && (p.d ?? null) === (r.d ?? null);
    });
    if (!sameContent) {
      setRows(ensureSingleTrailingDraftRow(persistedFilled));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, persistedFilled]);

  /** Persiste no projeto: filtra vazias e envia. */
  const commit = useCallback((next: AdditiveCalculationMemoryRow[]) => {
    onChange(next.filter(isMemoryRowFilled));
  }, [onChange]);

  /** Refs por célula para navegação. */
  const cellRefs = useRef<Map<string, HTMLElement>>(new Map());
  const setCellRef = (rowId: string, field: EditField) => (el: HTMLElement | null) => {
    const k = `${rowId}:${field}`;
    if (el) cellRefs.current.set(k, el); else cellRefs.current.delete(k);
  };
  const focusCell = (rowId: string, field: EditField) => {
    requestAnimationFrame(() => {
      const el = cellRefs.current.get(`${rowId}:${field}`);
      if (el) {
        try { (el as HTMLInputElement).focus({ preventScroll: true }); }
        catch { (el as HTMLInputElement).focus(); }
        if ('select' in el) try { (el as HTMLInputElement).select(); } catch { /* noop */ }
      }
    });
  };

  /**
   * onChange das células: APENAS atualiza estado local (rows). Não cria linhas novas.
   */
  const onCellChange = (
    rowId: string,
    field: EditField,
    rawValue: string,
  ) => {
    setRows(prev => prev.map(r => {
      if (r.id !== rowId) return r;
      let patch: Partial<AdditiveCalculationMemoryRow>;
      if (field === 'type') patch = { type: rawValue as 'acrescida' | 'suprimida' };
      else if (field === 'comment') patch = { comment: rawValue };
      else if (field === 'formula') patch = { formula: rawValue };
      else patch = { [field]: numOrUndef(rawValue) } as Partial<AdditiveCalculationMemoryRow>;
      return recalcMemoryRow({ ...r, ...patch });
    }));
  };

  /**
   * Reconciliação: garante linha vazia única no fim.
   * Chamada após eventos de confirmação (blur, enter, tab, dup, del, +).
   * Persiste no projeto e devolve as linhas finais (para focar próxima linha se necessário).
   */
  const reconcile = useCallback((preferredType?: 'acrescida' | 'suprimida') => {
    let finalRows: AdditiveCalculationMemoryRow[] = [];
    setRows(prev => {
      finalRows = ensureSingleTrailingDraftRow(prev, preferredType);
      return finalRows;
    });
    // Persistência fora do setter para não duplicar.
    requestAnimationFrame(() => commit(finalRows));
    return finalRows;
  }, [commit]);

  const handleBlur = () => {
    if (isLocked) return;
    reconcile();
  };

  /** Navegação por teclado entre células (Enter/Tab + setas tipo planilha). */
  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLElement>,
    rowIndex: number,
    fieldIndex: number,
  ) => {
    if (isLocked) return;
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const isInput = target.tagName === 'INPUT';
    const isText = isInput && (target as HTMLInputElement).type !== 'number';
    const caretAtStart = isInput ? (target as HTMLInputElement).selectionStart === 0 : true;
    const caretAtEnd = isInput
      ? (target as HTMLInputElement).selectionEnd === (target as HTMLInputElement).value.length
      : true;

    let dir: 'next' | 'prev' | 'up' | 'down' | null = null;
    if (e.key === 'Enter' || e.key === 'Tab') dir = e.shiftKey ? 'prev' : 'next';
    else if (e.key === 'ArrowRight' && (!isText || caretAtEnd)) dir = 'next';
    else if (e.key === 'ArrowLeft' && (!isText || caretAtStart)) dir = 'prev';
    else if (e.key === 'ArrowDown') dir = 'down';
    else if (e.key === 'ArrowUp') dir = 'up';
    if (!dir) return;

    // Bloqueia ANTES de qualquer outra coisa — impede scroll da página
    // e saída do escopo da grade, mesmo que não exista célula destino.
    e.preventDefault();
    e.stopPropagation();

    let nextRow = rowIndex;
    let nextField = fieldIndex;
    if (dir === 'next') {
      nextField = fieldIndex + 1;
      if (nextField >= EDIT_FIELDS.length) { nextField = 0; nextRow = rowIndex + 1; }
    } else if (dir === 'prev') {
      nextField = fieldIndex - 1;
      if (nextField < 0) { nextField = EDIT_FIELDS.length - 1; nextRow = rowIndex - 1; }
    } else if (dir === 'down') {
      nextRow = rowIndex + 1;
    } else if (dir === 'up') {
      nextRow = rowIndex - 1;
    }

    // Reconcilia (cria linha vazia se necessário) ANTES de focar.
    const finalRows = reconcile();

    // Clampa nos limites: se nextRow < 0 mantém o foco; se passar do fim, fica na última.
    if (nextRow < 0) return;
    const safeRow = Math.min(Math.max(nextRow, 0), finalRows.length - 1);
    const tgt = finalRows[safeRow];
    if (tgt) focusCell(tgt.id, EDIT_FIELDS[nextField]);
  };

  /** Botão "+ Acrescida" / "+ Suprimida": força linha vazia com o tipo escolhido. */
  const addManual = (type: 'acrescida' | 'suprimida') => {
    const finalRows = reconcile(type);
    // Foca o comentário da última linha (vazia).
    const last = finalRows[finalRows.length - 1];
    if (last) focusCell(last.id, 'comment');
  };

  const dupRow = (id: string) => {
    setRows(prev => {
      const idx = prev.findIndex(r => r.id === id);
      if (idx < 0) return prev;
      const orig = prev[idx];
      if (!isMemoryRowFilled(orig)) return prev;
      const copy = recalcMemoryRow({ ...orig, id: makeMemoryRow().id });
      const next = [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
      const reconciled = ensureSingleTrailingDraftRow(next);
      requestAnimationFrame(() => commit(reconciled));
      return reconciled;
    });
  };

  const delRow = (id: string) => {
    setRows(prev => {
      const next = prev.filter(r => r.id !== id);
      const reconciled = ensureSingleTrailingDraftRow(next);
      requestAnimationFrame(() => commit(reconciled));
      return reconciled;
    });
  };

  const setColLabel = (k: 'a' | 'b' | 'c' | 'd', value: string) => {
    if (!onChangeColumns) return;
    onChangeColumns({ ...(c.calculationMemoryColumns ?? {}), [k]: value });
  };

  // Totais visuais ignoram linhas vazias.
  const totalAcrescida = rows
    .filter(r => isMemoryRowFilled(r) && r.type !== 'suprimida')
    .reduce((acc, r) => acc + (Number.isFinite(r.partial) ? r.partial : 0), 0);
  const totalSuprimida = rows
    .filter(r => isMemoryRowFilled(r) && r.type === 'suprimida')
    .reduce((acc, r) => acc + (Number.isFinite(r.partial) ? r.partial : 0), 0);

  // Linhas exibidas: estado local (sem draft extra, pois `rows` já contém).
  const displayed = isLocked ? rows.filter(isMemoryRowFilled) : rows;

  // Foco inicial ao abrir sem nenhuma linha preenchida: foca o comentário da linha vazia.
  const didInitialFocusRef = useRef(false);
  useEffect(() => {
    if (didInitialFocusRef.current) return;
    if (isLocked) return;
    if (displayed.length > 0 && !isMemoryRowFilled(displayed[displayed.length - 1])) {
      didInitialFocusRef.current = true;
      focusCell(displayed[displayed.length - 1].id, 'comment');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="border rounded-md bg-background p-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-muted-foreground">
          Memória de cálculo — {c.itemNumber || c.item} {c.description}
        </div>
        {!isLocked && (
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => addManual('acrescida')}>
              <Plus className="w-3 h-3 mr-1" /> Acrescida
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => addManual('suprimida')}>
              <Plus className="w-3 h-3 mr-1" /> Suprimida
            </Button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px] table-fixed">
          <colgroup>
            <col style={{ width: 36 }} />
            <col style={{ width: 88 }} />
            <col />
            <col style={{ width: 110 }} />
            <col style={{ width: 64 }} />
            <col style={{ width: 64 }} />
            <col style={{ width: 64 }} />
            <col style={{ width: 64 }} />
            <col style={{ width: 78 }} />
            <col style={{ width: 56 }} />
          </colgroup>
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="px-1 py-1 text-center font-medium">Loc</th>
              <th className="px-1.5 py-1 text-left font-medium">Tipo</th>
              <th className="px-1.5 py-1 text-left font-medium">Comentário</th>
              <th className="px-1.5 py-1 text-left font-medium">Fórmula</th>
              <th className="px-1.5 py-1 text-right font-medium">
                <EditableHeader value={labels.a} defaultValue="UND" disabled={isLocked || !onChangeColumns} onCommit={v => setColLabel('a', v)} />
              </th>
              <th className="px-1.5 py-1 text-right font-medium">
                <EditableHeader value={labels.b} defaultValue="Comprim." disabled={isLocked || !onChangeColumns} onCommit={v => setColLabel('b', v)} />
              </th>
              <th className="px-1.5 py-1 text-right font-medium">
                <EditableHeader value={labels.c} defaultValue="Largura" disabled={isLocked || !onChangeColumns} onCommit={v => setColLabel('c', v)} />
              </th>
              <th className="px-1.5 py-1 text-right font-medium">
                <EditableHeader value={labels.d} defaultValue="Altura" disabled={isLocked || !onChangeColumns} onCommit={v => setColLabel('d', v)} />
              </th>
              <th className="px-1.5 py-1 text-right font-medium">Parcial</th>
              <th className="px-1.5 py-1 text-center font-medium">Ações</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((r, rowIndex) => {
              const filled = isMemoryRowFilled(r);
              const isDraftRow = !isLocked && !filled && rowIndex === displayed.length - 1;
              const ev = evalMemoryFormula(r.formula ?? '', { a: r.a, b: r.b, c: r.c, d: r.d });
              const isInvalid = filled && !ev.ok;
              const isNegative = filled && ev.ok && ev.value < 0;
              const rowBg = isDraftRow
                ? 'bg-muted/10'
                : isInvalid
                  ? 'bg-rose-50/50'
                  : r.type === 'suprimida' ? 'bg-rose-50/20' : 'bg-emerald-50/20';
              return (
                <tr key={r.id} className={`border-b align-top ${rowBg}`}>
                  <td className="px-1 py-1 text-center font-mono text-muted-foreground">
                    {rowIndex + 1}
                  </td>
                  <td className="px-1.5 py-1">
                    <select
                      ref={setCellRef(r.id, 'type') as any}
                      value={r.type}
                      disabled={isLocked}
                      data-grid-id={`additive-memory-${c.id}`}
                      data-row-index={rowIndex}
                      data-col-index={0}
                      onChange={e => onCellChange(r.id, 'type', e.target.value)}
                      onBlur={handleBlur}
                      onKeyDown={e => handleKeyDown(e, rowIndex, 0)}
                      className="h-7 w-full text-[11px] border border-input rounded-md bg-background px-1"
                    >
                      <option value="acrescida">Acrescida</option>
                      <option value="suprimida">Suprimida</option>
                    </select>
                  </td>
                  <td className="px-1.5 py-1">
                    <Input
                      ref={setCellRef(r.id, 'comment') as any}
                      value={r.comment ?? ''}
                      disabled={isLocked}
                      data-grid-id={`additive-memory-${c.id}`}
                      data-row-index={rowIndex}
                      data-col-index={1}
                      onChange={e => onCellChange(r.id, 'comment', e.target.value)}
                      onBlur={handleBlur}
                      onKeyDown={e => handleKeyDown(e, rowIndex, 1)}
                      className="h-7 text-[11px]"
                      placeholder={isDraftRow ? 'Justificativa (digite para iniciar)' : 'Justificativa'}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <Input
                      ref={setCellRef(r.id, 'formula') as any}
                      value={r.formula ?? ''}
                      disabled={isLocked}
                      data-grid-id={`additive-memory-${c.id}`}
                      data-row-index={rowIndex}
                      data-col-index={2}
                      onChange={e => onCellChange(r.id, 'formula', e.target.value)}
                      onBlur={handleBlur}
                      onKeyDown={e => handleKeyDown(e, rowIndex, 2)}
                      className={`h-7 text-[11px] font-mono ${isInvalid ? 'border-rose-400' : ''}`}
                      placeholder={placeholder}
                      title={isInvalid ? ev.error : `Fórmula opcional. Use A, B, C, D, +, -, *, /, ( ). Padrão: ${placeholder}`}
                    />
                  </td>
                  {(['a', 'b', 'c', 'd'] as const).map((k, kIdx) => (
                    <td key={k} className="px-1.5 py-1">
                      <Input
                        ref={setCellRef(r.id, k) as any}
                        type="text"
                        inputMode="decimal"
                        value={r[k] == null ? '' : String(r[k]).replace('.', ',')}
                        disabled={isLocked}
                        data-grid-id={`additive-memory-${c.id}`}
                        data-row-index={rowIndex}
                        data-col-index={3 + kIdx}
                        onChange={e => {
                          const v = e.target.value;
                          if (v === '' || /^-?[0-9]*[.,]?[0-9]*$/.test(v)) onCellChange(r.id, k, v);
                        }}
                        onBlur={handleBlur}
                        onKeyDown={e => handleKeyDown(e, rowIndex, 3 + kIdx)}
                        onFocus={e => e.currentTarget.select()}
                        className="h-7 text-[11px] text-right px-1 no-spinner"
                      />
                    </td>
                  ))}
                  <td className={`px-1.5 py-1 text-right font-medium ${isNegative ? 'text-amber-700' : ''}`}>
                    <div className="inline-flex items-center gap-1">
                      {(isInvalid || isNegative) && (
                        <AlertTriangle className={`w-3 h-3 ${isInvalid ? 'text-rose-600' : 'text-amber-600'}`} />
                      )}
                      {filled ? fmtNum(r.partial) : ''}
                    </div>
                  </td>
                  <td className="px-1.5 py-1 text-center">
                    {!isLocked && !isDraftRow && (
                      <div className="inline-flex gap-0.5">
                        <button onClick={() => dupRow(r.id)} className="p-1 hover:bg-muted rounded" title="Duplicar">
                          <Copy className="w-3 h-3" />
                        </button>
                        <button onClick={() => delRow(r.id)} className="p-1 hover:bg-muted rounded text-rose-600" title="Excluir">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {(totalAcrescida !== 0 || totalSuprimida !== 0) && (
            <tfoot>
              <tr className="border-t font-medium">
                <td colSpan={8} className="px-1.5 py-1 text-right">Total Acrescida:</td>
                <td className="px-1.5 py-1 text-right text-emerald-700">{fmtNum(totalAcrescida)}</td>
                <td />
              </tr>
              <tr className="font-medium">
                <td colSpan={8} className="px-1.5 py-1 text-right">Total Suprimida:</td>
                <td className="px-1.5 py-1 text-right text-rose-700">{fmtNum(totalSuprimida)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

export default memo(AdditiveCalculationMemoryImpl);
