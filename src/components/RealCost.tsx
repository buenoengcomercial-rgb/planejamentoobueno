import { Fragment, useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Layers3,
  Search,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { buildRealCostAnalysis, type RealCostCompositionRow, type RealCostSignal } from '@/lib/realCost';
import { fmtBRL, fmtPct } from '@/components/measurement/measurementFormat';
import { loadObraConfig } from '@/components/ConfiguracaoObra';

interface Props {
  project: Project;
}

const SIGNAL_META: Record<RealCostSignal, { label: string; cls: string; dot: string }> = {
  healthy: {
    label: 'Saudavel',
    cls: 'border-success/35 bg-success/10 text-success',
    dot: 'bg-success',
  },
  attention: {
    label: 'Atencao',
    cls: 'border-warning/40 bg-warning/10 text-warning',
    dot: 'bg-warning',
  },
  danger: {
    label: 'Critico',
    cls: 'border-destructive/35 bg-destructive/10 text-destructive',
    dot: 'bg-destructive',
  },
  incomplete: {
    label: 'Incompleto',
    cls: 'border-border bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
};

function SignalBadge({ signal }: { signal: RealCostSignal }) {
  const meta = SIGNAL_META[signal];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.cls}`}>
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  icon: React.ElementType;
}) {
  const toneClass =
    tone === 'success' ? 'text-success' :
    tone === 'warning' ? 'text-warning' :
    tone === 'danger' ? 'text-destructive' :
    'text-primary';
  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className={`mt-1 text-lg font-bold tabular-nums ${toneClass}`}>{value}</p>
          {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
        </div>
        <Icon className={`mt-0.5 h-4 w-4 ${toneClass}`} />
      </div>
    </Card>
  );
}

function PendingMini({ label, value }: { label: string; value: number }) {
  const hasIssue = value > 0;
  return (
    <div className={`rounded-md border px-2.5 py-1.5 ${hasIssue ? 'border-warning/35 bg-warning/10' : 'border-success/30 bg-success/10'}`}>
      <p className={`text-sm font-bold tabular-nums ${hasIssue ? 'text-warning' : 'text-success'}`}>{value}</p>
      <p className="text-[10px] leading-tight text-muted-foreground">{label}</p>
    </div>
  );
}

function marginTone(value: number) {
  if (value < 5) return 'text-destructive';
  if (value < 15) return 'text-warning';
  return 'text-success';
}

function signalFromRows(rows: RealCostCompositionRow[], marginPct: number): RealCostSignal {
  if (rows.length === 0 || rows.some(row => row.signal === 'incomplete')) return 'incomplete';
  if (marginPct < 5) return 'danger';
  if (marginPct < 15) return 'attention';
  return 'healthy';
}

function pendingCount(row: RealCostCompositionRow) {
  return (
    row.missingQuoteCount +
    (row.hasAnalytic ? 0 : 1) +
    (row.hasScheduleLink ? 0 : 1) +
    (row.hasContractValue ? 0 : 1)
  );
}

function formatDate(value?: string) {
  if (!value) return '-';
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

export default function RealCost({ project }: Props) {
  const trabalhaSabado = useMemo(() => loadObraConfig().trabalhaSabado, []);
  const analysis = useMemo(() => buildRealCostAnalysis(project, trabalhaSabado), [project, trabalhaSabado]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | RealCostSignal>('all');
  const [chapterFilter, setChapterFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filteredCompositions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return analysis.compositions.filter(row => {
      if (statusFilter !== 'all' && row.signal !== statusFilter) return false;
      if (chapterFilter !== 'all' && row.chapterId !== chapterFilter) return false;
      if (!q) return true;
      const blob = `${row.item} ${row.code ?? ''} ${row.bank ?? ''} ${row.description} ${row.chapter} ${row.sourceName}`.toLowerCase();
      return blob.includes(q);
    });
  }, [analysis.compositions, chapterFilter, search, statusFilter]);

  const groupedChapters = useMemo(() => {
    return analysis.chapters
      .map(chapter => {
        const rows = filteredCompositions.filter(row => row.chapterId === chapter.id);
        const contractedValue = rows.reduce((sum, row) => sum + row.contractedValue, 0);
        const realCost = rows.reduce((sum, row) => sum + row.realCost, 0);
        const grossProfit = contractedValue - realCost;
        const marginPct = contractedValue > 0 ? (grossProfit / contractedValue) * 100 : 0;
        return {
          id: chapter.id,
          chapter: chapter.chapter,
          rows,
          contractedValue,
          realCost,
          grossProfit,
          marginPct,
          pendingCompositionCount: rows.filter(row => row.signal === 'incomplete').length,
          signal: signalFromRows(rows, marginPct),
        };
      })
      .filter(group => group.rows.length > 0);
  }, [analysis.chapters, filteredCompositions]);

  const maxMonthValue = Math.max(1, ...analysis.months.map(month => Math.max(month.contractedValue, month.realCost)));

  return (
    <div className="p-3 lg:p-4 space-y-3 max-w-[1900px] mx-auto">
      <header className="rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <CircleDollarSign className="h-5 w-5 text-primary" />
              <h1 className="text-xl font-bold text-foreground">Custo real de obra</h1>
            </div>
            <p className="mt-1 max-w-4xl text-xs text-muted-foreground">
              Planilha interna de margem: compara o valor contratado com BDI contra o custo real cotado na Lista de Material.
              Nao altera Medicao, Aditivo, Cronograma, Lista de Material ou Almoxarifado.
            </p>
          </div>
          <SignalBadge signal={analysis.totals.signal} />
        </div>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-2">
        <StatCard
          label="Valor contratado"
          value={fmtBRL(analysis.totals.contractedValue)}
          hint="Receita com BDI"
          icon={CircleDollarSign}
        />
        <StatCard
          label="Custo real cotado"
          value={fmtBRL(analysis.totals.realCost)}
          hint="Menor cotacao por insumo"
          icon={BarChart3}
          tone="warning"
        />
        <StatCard
          label="Lucro bruto estimado"
          value={fmtBRL(analysis.totals.grossProfit)}
          hint="Contrato - custo cotado"
          icon={analysis.totals.grossProfit >= 0 ? TrendingUp : TrendingDown}
          tone={analysis.totals.grossProfit >= 0 ? 'success' : 'danger'}
        />
        <StatCard
          label="Margem estimada"
          value={fmtPct(analysis.totals.marginPct)}
          hint="Semaforo por composicao"
          icon={analysis.totals.marginPct >= 15 ? CheckCircle2 : AlertTriangle}
          tone={analysis.totals.marginPct >= 15 ? 'success' : analysis.totals.marginPct >= 5 ? 'warning' : 'danger'}
        />
        <Card className="p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pendencias</p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <PendingMini label="sem cotacao" value={analysis.pending.inputsWithoutQuote} />
            <PendingMini label="margem incompleta" value={analysis.pending.incompleteCompositions} />
          </div>
        </Card>
      </section>

      <Card className="overflow-hidden">
        <div className="border-b border-border bg-muted/30 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Planilha de custo real</h2>
              <p className="text-[11px] text-muted-foreground">
                Capitulos e composicoes no mesmo quadro. Clique em uma composicao para abrir a analitica do custo real.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <PendingMini label="insumos sem cotacao" value={analysis.pending.inputsWithoutQuote} />
              <PendingMini label="sem analitica" value={analysis.pending.compositionsWithoutAnalytic} />
              <PendingMini label="sem Gantt" value={analysis.pending.itemsWithoutScheduleLink} />
              <PendingMini label="sem contrato" value={analysis.pending.itemsWithoutContractValue} />
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <div className="relative min-w-[260px] flex-1">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Buscar item, codigo, capitulo ou descricao..."
                className="h-8 pl-7 text-xs"
              />
            </div>
            <select
              value={chapterFilter}
              onChange={event => setChapterFilter(event.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="all">Todos os capitulos</option>
              {analysis.chapters.map(chapter => (
                <option key={chapter.id} value={chapter.id}>{chapter.chapter}</option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="all">Todos os status</option>
              <option value="healthy">Margem saudavel</option>
              <option value="attention">Atencao</option>
              <option value="danger">Critico</option>
              <option value="incomplete">Incompleto</option>
            </select>
          </div>
        </div>

        <div className="max-h-[680px] overflow-auto">
          <table className="w-full min-w-[1320px] text-xs">
            <thead className="sticky top-0 z-20">
              <tr className="bg-slate-950 text-white">
                <th className="p-2 text-left w-24">Item</th>
                <th className="p-2 text-left w-24">Codigo</th>
                <th className="p-2 text-left w-20">Banco</th>
                <th className="p-2 text-left min-w-[360px]">Descricao</th>
                <th className="p-2 text-center w-16">Un.</th>
                <th className="p-2 text-right w-24">Qtd.</th>
                <th className="p-2 text-right w-36">Valor contratado</th>
                <th className="p-2 text-right w-36">Custo real cotado</th>
                <th className="p-2 text-right w-32">Lucro bruto</th>
                <th className="p-2 text-right w-24">Margem</th>
                <th className="p-2 text-center w-24">Pend.</th>
                <th className="p-2 text-center w-28">Semaforo</th>
              </tr>
            </thead>
            <tbody>
              {groupedChapters.map(group => (
                <Fragment key={`group-${group.id}`}>
                  <tr key={`chapter-${group.id}`} className="border-y border-primary/20 bg-blue-50 text-blue-950">
                    <td colSpan={4} className="p-2 font-bold">
                      {group.chapter}
                      <span className="ml-2 text-[10px] font-medium text-blue-700">{group.rows.length} composicao(oes)</span>
                    </td>
                    <td className="p-2 text-center font-semibold">-</td>
                    <td className="p-2 text-right font-semibold">-</td>
                    <td className="p-2 text-right font-bold tabular-nums">{fmtBRL(group.contractedValue)}</td>
                    <td className="p-2 text-right font-bold tabular-nums">{fmtBRL(group.realCost)}</td>
                    <td className={`p-2 text-right font-bold tabular-nums ${group.grossProfit >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {fmtBRL(group.grossProfit)}
                    </td>
                    <td className={`p-2 text-right font-bold tabular-nums ${marginTone(group.marginPct)}`}>{fmtPct(group.marginPct)}</td>
                    <td className="p-2 text-center font-semibold">{group.pendingCompositionCount}</td>
                    <td className="p-2 text-center"><SignalBadge signal={group.signal} /></td>
                  </tr>
                  {group.rows.map(row => {
                    const expanded = expandedId === row.id;
                    return (
                      <Fragment key={`row-${row.id}`}>
                        <tr
                          key={row.id}
                          className={`cursor-pointer border-b border-border hover:bg-muted/40 ${expanded ? 'bg-primary/10' : ''}`}
                          onClick={() => setExpandedId(expanded ? null : row.id)}
                        >
                          <td className="p-2 align-top font-mono text-[11px]">
                            <span className="inline-flex items-center gap-1">
                              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              {row.item || '-'}
                            </span>
                          </td>
                          <td className="p-2 align-top font-mono text-[11px]">{row.code || '-'}</td>
                          <td className="p-2 align-top text-muted-foreground">{row.bank || '-'}</td>
                          <td className="p-2 align-top">
                            <div className="font-medium leading-snug">{row.description}</div>
                            <div className="mt-0.5 text-[10px] text-muted-foreground">{row.sourceName}</div>
                          </td>
                          <td className="p-2 align-top text-center">{row.unit}</td>
                          <td className="p-2 align-top text-right tabular-nums">{row.quantity.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}</td>
                          <td className="p-2 align-top text-right tabular-nums">{fmtBRL(row.contractedValue)}</td>
                          <td className="p-2 align-top text-right tabular-nums">{fmtBRL(row.realCost)}</td>
                          <td className={`p-2 align-top text-right tabular-nums font-semibold ${row.grossProfit >= 0 ? 'text-success' : 'text-destructive'}`}>
                            {fmtBRL(row.grossProfit)}
                          </td>
                          <td className={`p-2 align-top text-right tabular-nums font-semibold ${marginTone(row.marginPct)}`}>{fmtPct(row.marginPct)}</td>
                          <td className="p-2 align-top text-center">{pendingCount(row)}</td>
                          <td className="p-2 align-top text-center"><SignalBadge signal={row.signal} /></td>
                        </tr>
                        {expanded && (
                          <tr key={`${row.id}-detail`} className="border-b border-primary/20 bg-primary/5">
                            <td colSpan={12} className="p-3">
                              <div className="rounded-lg border border-border bg-card overflow-hidden">
                                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
                                  <div>
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Composicao analitica do custo real</p>
                                    <p className="text-xs font-medium">{row.item} - {row.description}</p>
                                  </div>
                                  <div className="flex flex-wrap gap-2 text-[11px]">
                                    <span className="rounded border border-border px-2 py-1">Contrato: <strong>{fmtBRL(row.contractedValue)}</strong></span>
                                    <span className="rounded border border-border px-2 py-1">Custo real: <strong>{fmtBRL(row.realCost)}</strong></span>
                                    <span className="rounded border border-border px-2 py-1">Lucro: <strong className={row.grossProfit >= 0 ? 'text-success' : 'text-destructive'}>{fmtBRL(row.grossProfit)}</strong></span>
                                  </div>
                                </div>
                                {row.inputs.length === 0 ? (
                                  <div className="p-5 text-center text-xs text-muted-foreground">
                                    Composicao sem analitica vinculada. Ela continua na planilha, mas a margem fica incompleta.
                                  </div>
                                ) : (
                                  <div className="overflow-auto">
                                    <table className="w-full min-w-[1120px] text-xs">
                                      <thead className="bg-muted text-muted-foreground">
                                        <tr>
                                          <th className="p-2 text-left w-24">Codigo</th>
                                          <th className="p-2 text-left w-20">Banco</th>
                                          <th className="p-2 text-left">Insumo</th>
                                          <th className="p-2 text-center w-16">Un.</th>
                                          <th className="p-2 text-right w-24">Coef.</th>
                                          <th className="p-2 text-right w-24">Qtd. total</th>
                                          <th className="p-2 text-right w-28">Preco real</th>
                                          <th className="p-2 text-right w-28">Custo</th>
                                          <th className="p-2 text-left w-36">Fornecedor</th>
                                          <th className="p-2 text-left w-36">Grupo</th>
                                          <th className="p-2 text-center w-24">Data</th>
                                          <th className="p-2 text-center w-24">Status</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {row.inputs.map(input => (
                                          <tr key={input.id} className="border-t border-border">
                                            <td className="p-2 align-top font-mono text-[11px]">{input.code || '-'}</td>
                                            <td className="p-2 align-top text-muted-foreground">{input.bank || '-'}</td>
                                            <td className="p-2 align-top">
                                              <div className="font-medium leading-snug">{input.description}</div>
                                              {!input.priceSource && (
                                                <div className="mt-1 text-[10px] text-warning">Sem cotacao na Lista de Material.</div>
                                              )}
                                            </td>
                                            <td className="p-2 align-top text-center">{input.unit}</td>
                                            <td className="p-2 align-top text-right tabular-nums">{input.coefficient.toLocaleString('pt-BR', { maximumFractionDigits: 5 })}</td>
                                            <td className="p-2 align-top text-right tabular-nums">{input.totalQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}</td>
                                            <td className="p-2 align-top text-right tabular-nums">{input.priceSource ? fmtBRL(input.priceSource.unitPrice) : '-'}</td>
                                            <td className="p-2 align-top text-right tabular-nums font-semibold">{input.priceSource ? fmtBRL(input.realTotal) : '-'}</td>
                                            <td className="p-2 align-top">{input.priceSource?.supplierName || '-'}</td>
                                            <td className="p-2 align-top">{input.priceSource?.comparisonName || '-'}</td>
                                            <td className="p-2 align-top text-center">{formatDate(input.priceSource?.date)}</td>
                                            <td className="p-2 align-top text-center">
                                              {input.priceSource ? (
                                                <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">Cotado</span>
                                              ) : (
                                                <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning">Pendente</span>
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
              {groupedChapters.length === 0 && (
                <tr>
                  <td colSpan={12} className="p-8 text-center text-sm text-muted-foreground">
                    Nenhuma composicao encontrada com os filtros atuais.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
          <div>
            <div className="flex items-center gap-2">
              <Layers3 className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Distribuicao mensal pelo Cronograma</h2>
            </div>
            <p className="text-[11px] text-muted-foreground">Receita, custo real cotado, lucro e margem previstos conforme as datas do Gantt.</p>
          </div>
        </div>
        {analysis.months.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Vincule composicoes ao cronograma para ver a distribuicao mensal.
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full min-w-[980px] text-xs">
              <thead className="bg-slate-950 text-white">
                <tr>
                  <th className="p-2 text-left">Mes</th>
                  <th className="p-2 text-right">Receita prevista</th>
                  <th className="p-2 text-right">Custo real previsto</th>
                  <th className="p-2 text-right">Lucro previsto</th>
                  <th className="p-2 text-right">Margem</th>
                  <th className="p-2 text-center">Tarefas</th>
                  <th className="p-2 text-left">Comparativo visual</th>
                  <th className="p-2 text-center">Semaforo</th>
                </tr>
              </thead>
              <tbody>
                {analysis.months.map(month => (
                  <tr key={month.key} className="border-b border-border">
                    <td className="p-2 font-medium">{month.label}</td>
                    <td className="p-2 text-right tabular-nums">{fmtBRL(month.contractedValue)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtBRL(month.realCost)}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${month.grossProfit >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {fmtBRL(month.grossProfit)}
                    </td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${marginTone(month.marginPct)}`}>{fmtPct(month.marginPct)}</td>
                    <td className="p-2 text-center tabular-nums">{month.taskCount}</td>
                    <td className="p-2">
                      <div className="space-y-1">
                        <div className="h-2 w-full rounded-full bg-muted overflow-hidden" title="Receita prevista">
                          <div
                            className="h-2 rounded-full bg-primary/80"
                            style={{ width: `${Math.max(2, (month.contractedValue / maxMonthValue) * 100)}%` }}
                          />
                        </div>
                        <div className="h-2 w-full rounded-full bg-muted overflow-hidden" title="Custo real previsto">
                          <div
                            className="h-2 rounded-full bg-warning/80"
                            style={{ width: `${Math.max(2, (month.realCost / maxMonthValue) * 100)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="p-2 text-center"><SignalBadge signal={month.signal} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
