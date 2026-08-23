import { Fragment, useEffect } from 'react';
import { Task, DailyProductionLog, DailyLaborEntry } from '@/types/project';
import { ClipboardList, Plus, Trash2, TrendingUp, TrendingDown, PlusCircle, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';

interface DailyLogsPanelProps {
  task: Task;
  onChange: (logs: DailyProductionLog[]) => void;
  focusDate?: string;
  subcontractItems?: SubcontractProductionItem[];
}

export interface SubcontractProductionItem {
  allocationId: string;
  compositionId: string;
  item: string;
  description: string;
  unit: string;
  contractedQuantity: number;
  contractedAmount: number;
}

/** Status color por defasagem (planejado - realizado).
 * <= 0  → verde (no prazo / adiantado)
 * 0-20% → amarelo
 * > 20% → vermelho */
function statusForDelta(delta: number, planned: number): 'ok' | 'warn' | 'late' {
  if (delta <= 0 || planned <= 0) return 'ok';
  const ratio = delta / planned;
  if (ratio <= 0.2) return 'warn';
  return 'late';
}

const STATUS_BG: Record<string, string> = {
  ok: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  late: 'bg-destructive/10 text-destructive',
};

const EMPTY_DAILY_LOGS: DailyProductionLog[] = [];

export default function DailyLogsPanel({ task, onChange, focusDate, subcontractItems = [] }: DailyLogsPanelProps) {
  const logs = task.dailyLogs ?? EMPTY_DAILY_LOGS;
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const baseDuration = task.originalDuration ?? task.duration;
  const plannedDailyProduction = task.quantity && baseDuration > 0
    ? task.quantity / baseDuration
    : 0;

  const buildLog = (dateISO: string): DailyProductionLog => ({
    id: `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    date: dateISO,
    plannedQuantity: Math.round(plannedDailyProduction * 100) / 100,
    actualQuantity: 0,
  });

  const nextDayISO = (iso: string): string => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
    base.setDate(base.getDate() + 1);
    return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  };

  const addLog = () => {
    const today = new Date().toISOString().split('T')[0];
    const lastDate = logs.length > 0
      ? [...logs].sort((a, b) => a.date.localeCompare(b.date))[logs.length - 1].date
      : null;
    const date = lastDate ? nextDayISO(lastDate) : today;
    const newLog = buildLog(date);
    onChange([...logs, newLog]);
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-actual-input="${newLog.id}"]`);
      el?.focus();
      el?.select();
    }, 50);
  };

  const addLogAfter = (afterId: string) => {
    const ref = logs.find(l => l.id === afterId);
    const date = ref ? nextDayISO(ref.date) : new Date().toISOString().split('T')[0];
    const newLog = buildLog(date);
    onChange([...logs, newLog]);
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-actual-input="${newLog.id}"]`);
      el?.focus();
      el?.select();
    }, 50);
  };

  const updateLog = (id: string, updates: Partial<DailyProductionLog>) => {
    onChange(logs.map(l => l.id === id ? { ...l, ...updates } : l));
  };

  const removeLog = (id: string) => {
    onChange(logs.filter(l => l.id !== id));
  };

  useEffect(() => {
    if (!focusDate || !logs.some(log => log.date === focusDate)) return;
    const timer = window.setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-log-date="${focusDate}"]`);
      el?.focus();
      el?.select();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [focusDate, logs]);

  const addLaborEntry = (logId: string) => {
    const entry: DailyLaborEntry = {
      id: `labor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: '',
      workerName: '',
      teamCode: '',
      hours: 8,
      hourlyCost: 0,
    };
    const target = logs.find(log => log.id === logId);
    updateLog(logId, { laborEntries: [...(target?.laborEntries ?? []), entry] });
  };

  const updateLaborEntry = (logId: string, entryId: string, patch: Partial<DailyLaborEntry>) => {
    const target = logs.find(log => log.id === logId);
    updateLog(logId, {
      laborEntries: (target?.laborEntries ?? []).map(entry =>
        entry.id === entryId ? { ...entry, ...patch } : entry),
    });
  };

  const removeLaborEntry = (logId: string, entryId: string) => {
    const target = logs.find(log => log.id === logId);
    updateLog(logId, {
      laborEntries: (target?.laborEntries ?? []).filter(entry => entry.id !== entryId),
    });
  };

  const subcontractExecutedBefore = (allocationId: string, currentLogId: string) => logs.reduce((sum, log) => {
    if (log.id === currentLogId) return sum;
    return sum + (log.subcontractExecutions ?? [])
      .filter(execution => execution.allocationId === allocationId)
      .reduce((entrySum, execution) => entrySum + Math.max(0, Number(execution.quantity) || 0), 0);
  }, 0);

  const updateSubcontractExecution = (logId: string, item: SubcontractProductionItem, rawQuantity: number) => {
    const maximum = Math.max(0, item.contractedQuantity - subcontractExecutedBefore(item.allocationId, logId));
    const quantity = Math.min(maximum, Math.max(0, Number(rawQuantity) || 0));
    const target = logs.find(log => log.id === logId);
    const previous = target?.subcontractExecutions ?? [];
    const exists = previous.some(execution => execution.allocationId === item.allocationId);
    const subcontractExecutions = quantity <= 0
      ? previous.filter(execution => execution.allocationId !== item.allocationId)
      : exists
        ? previous.map(execution => execution.allocationId === item.allocationId ? { ...execution, quantity } : execution)
        : [...previous, { allocationId: item.allocationId, compositionId: item.compositionId, quantity }];
    updateLog(logId, { subcontractExecutions });
  };

  // Linhas: saldo dia, saldo acumulado, executado acumulado, falta executar
  let acc = 0;
  let execAcc = 0;
  const totalQty = task.quantity || 0;
  const sortedLogs = [...logs].sort((a, b) => a.date.localeCompare(b.date));
  const rows = sortedLogs.map(l => {
    const planned = l.plannedQuantity || 0;
    const actual = l.actualQuantity || 0;
    const delta = planned - actual;
    acc += delta;
    execAcc += actual;
    const remainingAfter = totalQty > 0 ? Math.max(totalQty - execAcc, 0) : 0;
    return {
      ...l,
      delta,
      accumulated: acc,
      executedAcc: execAcc,
      remainingAfter,
      status: statusForDelta(delta, planned),
    };
  });

  // Preview em tempo real do "Previsto" — atualiza imediatamente ao digitar realizado.
  // Regra: previsto = EXATAMENTE a última data registrada no diário (sem somar saldo).
  const parseLocal = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  };
  const formatBR = (iso: string) => {
    const d = parseLocal(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };
  const previewStartDate = sortedLogs.length > 0
    ? sortedLogs[0].date
    : (task.current?.startDate ?? task.startDate);
  const lastLogDateISO = sortedLogs.length > 0 ? sortedLogs[sortedLogs.length - 1].date : previewStartDate;
  const previewEndDate = sortedLogs.length === 0
    ? (task.current?.forecastEndDate ?? task.current?.endDate ?? task.startDate)
    : lastLogDateISO;
  const previewDuration = Math.max(
    1,
    Math.ceil((parseLocal(previewEndDate).getTime() - parseLocal(previewStartDate).getTime()) / 86400000) + 1
  );

  const accStatus = statusForDelta(task.accumulatedDelayQuantity || 0, plannedDailyProduction);
  const unit = task.unit || 'un';

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="overflow-hidden border-t border-border bg-muted/10"
    >
      <div className="px-8 py-3 space-y-3">
        {task.baseline && (
          <div className="flex items-center gap-2 flex-wrap text-[10px] bg-card border border-border rounded-md px-2 py-1">
            <span className="font-semibold text-muted-foreground uppercase tracking-wider">Cronograma:</span>
            <span className="text-muted-foreground">Base: <strong className="text-foreground">{task.baseline.duration}d</strong> ({formatBR(task.baseline.startDate)} → {formatBR(task.baseline.endDate)})</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">Previsto: <strong className="text-primary">{previewDuration}d</strong> ({formatBR(previewStartDate)} → {formatBR(previewEndDate)})</span>
            {(() => {
              const dev = previewDuration - task.baseline.duration;
              if (dev === 0) return null;
              const cls = dev <= 0 ? 'text-success' : dev <= 2 ? 'text-warning' : 'text-destructive';
              return <span className={`font-bold ${cls}`}>· Desvio: {dev > 0 ? '+' : ''}{dev}d</span>;
            })()}
          </div>
        )}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h4 className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
            <ClipboardList className="w-3.5 h-3.5 text-info" />
            Apontamento Diário — meta: <strong>{plannedDailyProduction.toFixed(1)} {unit}/dia</strong>
          </h4>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${STATUS_BG[accStatus]}`}>
              Saldo: {(task.accumulatedDelayQuantity || 0).toFixed(1)} {unit}
            </span>
            {sortedLogs.length > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                Previsão: {formatBR(previewEndDate)}
              </span>
            )}
            {task.physicalProgress !== undefined && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-info/10 text-info font-medium">
                Físico: {task.physicalProgress.toFixed(1)}%
              </span>
            )}
            <button
              onClick={addLog}
              className="text-[10px] px-2 py-1 rounded-md bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors flex items-center gap-1"
              title="Adicionar lançamento ao final"
            >
              <Plus className="w-3 h-3" /> Novo
            </button>
          </div>
        </div>

        {(() => {
          const logsComQty = sortedLogs.filter(l => (l.actualQuantity ?? 0) > 0);
          if (logsComQty.length === 0) return null;
          const realStart = logsComQty[0].date;
          const executedTotal = logsComQty.reduce((s, l) => s + (l.actualQuantity || 0), 0);
          const remaining = Math.max(0, (task.quantity || 0) - executedTotal);
          const progress = task.quantity ? Math.min(100, (executedTotal / task.quantity) * 100) : 0;
          const avgDaily = executedTotal / logsComQty.length;
          const daysRemaining = avgDaily > 0 ? Math.ceil(remaining / avgDaily) : 0;
          const lastDate = logsComQty[logsComQty.length - 1].date;
          const [ly, lm, ld] = lastDate.split('-').map(Number);
          const fd = new Date(ly, lm - 1, ld + daysRemaining);
          const forecastISO = `${fd.getFullYear()}-${String(fd.getMonth() + 1).padStart(2, '0')}-${String(fd.getDate()).padStart(2, '0')}`;
          const plannedEndISO = task.baseline?.endDate ?? task.current?.endDate ?? task.startDate;
          const isLate = forecastISO > plannedEndISO;
          return (
            <div className="grid grid-cols-3 gap-2 p-2 bg-muted/30 rounded-lg">
              <div className="text-center">
                <div className="text-[9px] text-muted-foreground uppercase">Início real</div>
                <div className="text-[11px] font-semibold text-info">{formatBR(realStart)}</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] text-muted-foreground uppercase">Executado</div>
                <div className="text-[11px] font-semibold text-foreground">
                  {executedTotal.toFixed(1)} / {task.quantity ?? 0} {unit}
                </div>
                <div className="text-[10px] font-bold text-primary">{progress.toFixed(1)}%</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] text-muted-foreground uppercase">Prev. término</div>
                <div className={`text-[11px] font-semibold ${isLate ? 'text-destructive' : 'text-success'}`}>
                  {formatBR(forecastISO)}
                </div>
              </div>
            </div>
          );
        })()}

        <div className="grid grid-cols-8 gap-2 text-[10px] font-semibold text-muted-foreground uppercase">
          <div>Data</div>
          <div className="text-center">Meta ({unit})</div>
          <div className="text-center">Realizado ({unit})</div>
          <div className="text-center">Saldo Dia</div>
          <div className="text-center">Saldo Acum.</div>
          <div className="text-center">Falta Executar</div>
          <div>Obs.</div>
          <div className="text-center">Ação</div>
        </div>

        {rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-3">
            <p className="text-[11px] text-muted-foreground italic">
              Sem lançamentos. Adicione o primeiro registro de produção.
            </p>
            <button
              onClick={addLog}
              className="text-[11px] px-3 py-1.5 rounded-md bg-primary/10 text-primary font-medium hover:bg-primary/20 transition-colors flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" /> Adicionar lançamento
            </button>
          </div>
        )}

        {rows.map(row => (
          <Fragment key={row.id}>
            <div
              className={`grid grid-cols-8 gap-2 text-[11px] items-center py-1 px-2 rounded ${STATUS_BG[row.status]}`}
            >
            <div className="flex items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); addLogAfter(row.id); }}
                className="p-1 rounded hover:bg-primary/20 text-primary transition-colors shrink-0"
                title="Adicionar novo lançamento abaixo"
              >
                <PlusCircle className="w-3.5 h-3.5" />
              </button>
              <input
                type="date"
                value={row.date}
                onChange={e => updateLog(row.id, { date: e.target.value })}
                className="bg-transparent border border-current/30 rounded px-1 py-0.5 text-[10px] focus:outline-none focus:border-current min-w-0 flex-1"
              />
            </div>
            <input
              type="number"
              min={0}
              step={0.1}
              value={row.plannedQuantity}
              onChange={e => updateLog(row.id, { plannedQuantity: Number(e.target.value) })}
              className="bg-transparent border border-current/30 rounded px-1 py-0.5 text-[11px] text-center focus:outline-none focus:border-current"
            />
            <input
              type="number"
              min={0}
              step={0.1}
              value={row.actualQuantity}
              data-actual-input={row.id}
              data-log-date={row.date}
              onChange={e => updateLog(row.id, { actualQuantity: Number(e.target.value) })}
              className="bg-transparent border border-current/30 rounded px-1 py-0.5 text-[11px] text-center font-bold focus:outline-none focus:border-current"
            />
            <div className="text-center font-bold flex items-center justify-center gap-1">
              {row.delta > 0 ? <TrendingDown className="w-3 h-3" /> : row.delta < 0 ? <TrendingUp className="w-3 h-3" /> : null}
              {row.delta.toFixed(1)}
            </div>
            <div className="text-center font-bold">{row.accumulated.toFixed(1)}</div>
            <div className={`text-center font-bold ${row.remainingAfter <= 0 ? 'text-success' : ''}`} title={`Falta executar após este lançamento: ${row.remainingAfter.toFixed(1)} ${unit}`}>
              {row.remainingAfter.toFixed(1)} {unit}
            </div>
            <input
              type="text"
              value={row.notes || ''}
              placeholder="—"
              onChange={e => updateLog(row.id, { notes: e.target.value })}
              className="bg-transparent border border-current/30 rounded px-1 py-0.5 text-[10px] focus:outline-none focus:border-current"
            />
            <div className="text-center flex items-center justify-center gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  addLaborEntry(row.id);
                }}
                className="p-1 rounded hover:bg-primary/20 text-primary transition-colors"
                title="Apontar mão de obra deste dia"
              >
                <Users className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  confirm(
                    {
                      title: 'Deseja excluir este lançamento diário?',
                      description: (
                        <>
                          <p>
                            Lançamento de <strong>{row.date}</strong> — Realizado: <strong>{row.actualQuantity ?? 0}</strong>.
                          </p>
                          <p>
                            Isso pode alterar o progresso físico, saldo, previsão de término, cronograma e medição.
                          </p>
                        </>
                      ),
                      confirmLabel: 'Excluir lançamento',
                    },
                    () => removeLog(row.id),
                  );
                }}
                className="p-1 rounded hover:bg-destructive/20 text-destructive transition-colors"
                title="Excluir lançamento"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            </div>
            {(row.laborEntries ?? []).length > 0 && (
              <div className="ml-8 mr-2 rounded-md border border-border/60 bg-card/70 p-2 space-y-1.5">
                <div className="grid grid-cols-[1.2fr_1fr_0.7fr_0.65fr_0.8fr_0.8fr_28px] gap-2 text-[9px] uppercase text-muted-foreground font-semibold">
                  <span>Trabalhador</span>
                  <span>Função</span>
                  <span>Equipe</span>
                  <span className="text-right">Horas</span>
                  <span className="text-right">Custo/h</span>
                  <span className="text-right">Custo</span>
                  <span />
                </div>
                {(row.laborEntries ?? []).map(entry => {
                  const laborTotal = (Number(entry.hours) || 0) * (Number(entry.hourlyCost) || 0);
                  return (
                    <div key={entry.id} className="grid grid-cols-[1.2fr_1fr_0.7fr_0.65fr_0.8fr_0.8fr_28px] gap-2 items-center">
                      <input
                        value={entry.workerName ?? ''}
                        placeholder="Nome"
                        onChange={event => updateLaborEntry(row.id, entry.id, { workerName: event.target.value })}
                        className="h-7 rounded border border-border bg-background px-2 text-[10px]"
                      />
                      <input
                        value={entry.role}
                        placeholder="Pedreiro"
                        onChange={event => updateLaborEntry(row.id, entry.id, { role: event.target.value })}
                        className="h-7 rounded border border-border bg-background px-2 text-[10px]"
                      />
                      <input
                        value={entry.teamCode ?? ''}
                        placeholder="Equipe"
                        onChange={event => updateLaborEntry(row.id, entry.id, { teamCode: event.target.value })}
                        className="h-7 rounded border border-border bg-background px-2 text-[10px]"
                      />
                      <input
                        type="number"
                        min={0}
                        step={0.25}
                        value={entry.hours}
                        onChange={event => updateLaborEntry(row.id, entry.id, { hours: Number(event.target.value) })}
                        className="h-7 rounded border border-border bg-background px-2 text-right text-[10px]"
                      />
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={entry.hourlyCost}
                        onChange={event => updateLaborEntry(row.id, entry.id, { hourlyCost: Number(event.target.value) })}
                        className="h-7 rounded border border-border bg-background px-2 text-right text-[10px]"
                      />
                      <span className="text-right text-[10px] font-semibold">
                        {laborTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeLaborEntry(row.id, entry.id)}
                        className="p-1 text-destructive hover:bg-destructive/10 rounded"
                        title="Excluir apontamento de mão de obra"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {subcontractItems.length > 0 && (
              <div className="ml-8 mr-2 rounded-md border border-primary/25 bg-primary/5 p-2 space-y-2">
                <div>
                  <p className="text-[10px] font-semibold text-primary">Produção terceirizada por composição</p>
                  <p className="text-[10px] text-muted-foreground">Este apontamento controla a medição física da terceirizada. Não lança pagamento automaticamente e não altera o realizado geral da tarefa.</p>
                </div>
                {subcontractItems.map(item => {
                  const current = (row.subcontractExecutions ?? []).find(execution => execution.allocationId === item.allocationId)?.quantity ?? 0;
                  const previous = subcontractExecutedBefore(item.allocationId, row.id);
                  const remaining = Math.max(0, item.contractedQuantity - previous);
                  const unitValue = item.contractedQuantity > 0 ? item.contractedAmount / item.contractedQuantity : 0;
                  return (
                    <div key={item.allocationId} className="grid gap-2 rounded border border-border/70 bg-card/80 p-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center">
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold">{item.item} — {item.description}</p>
                        <p className="text-[10px] text-muted-foreground">Saldo físico antes deste dia: {remaining.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} {item.unit} · R$ {unitValue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}/{item.unit}</p>
                      </div>
                      <label className="text-[10px] text-muted-foreground">Executado hoje
                        <input type="number" min={0} max={remaining} step="any" value={current} onChange={event => updateSubcontractExecution(row.id, item, Number(event.target.value))} className="mt-1 h-8 w-full min-w-28 rounded border border-border bg-background px-2 text-right text-sm" />
                      </label>
                      <span className="text-[10px] text-muted-foreground sm:text-right">Valor produzido<br /><strong className="text-foreground">{(current * unitValue).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</strong></span>
                    </div>
                  );
                })}
              </div>
            )}
          </Fragment>
        ))}
      </div>
      {confirmDialog}
    </motion.div>
  );
}
