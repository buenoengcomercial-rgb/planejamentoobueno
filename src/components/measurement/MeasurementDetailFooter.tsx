import { useState } from 'react';
import { Calculator, ChevronDown, Layers, PieChart } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { AdditiveComposition, Project } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { fmtBRL, fmtNum } from './measurementFormat';
import type { Row } from './types';

export type MeasurementDetailMode = 'quantity' | 'analytic' | 'classification';
export type MeasurementValueScope = 'contracted' | 'period' | 'forecast' | 'accum' | 'balance';

export interface MeasurementDetailSelection {
  taskId: string;
  mode: MeasurementDetailMode;
  valueScope?: MeasurementValueScope;
}

interface Props {
  project: Project;
  selection: MeasurementDetailSelection | null;
  row?: Row;
  bdi: number;
}

function sameText(a?: string, b?: string) {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

function findComposition(project: Project, row?: Row): AdditiveComposition | undefined {
  if (!row) return undefined;
  const all = [
    ...(project.additives ?? []).flatMap(a => a.compositions ?? []),
    ...(project.analyticCompositions ?? []),
  ];
  return all.find(c => c.taskId === row.taskId || c.linkedTaskId === row.taskId)
    ?? all.find(c => sameText(c.code, row.itemCode) && sameText(c.bank, row.priceBank))
    ?? all.find(c => sameText(c.description, row.description));
}

function scopeValues(row: Row, scope: MeasurementValueScope | undefined) {
  if (scope === 'period') return { label: 'Subtotal da medicao', withBdi: row.valuePeriod, noBdi: row.valuePeriodNoBDI };
  if (scope === 'forecast') return { label: 'Subtotal previsto', withBdi: row.valueForecast, noBdi: row.valueForecastNoBDI };
  if (scope === 'accum') return { label: 'Subtotal acumulado', withBdi: row.valueAccum, noBdi: row.valueAccumNoBDI };
  if (scope === 'balance') return { label: 'Subtotal a executar', withBdi: row.valueBalance, noBdi: row.valueBalanceNoBDI };
  return { label: 'Total contratado', withBdi: row.valueContracted, noBdi: row.valueContractedNoBDI };
}

function AnalyticView({ composition }: { composition?: AdditiveComposition }) {
  if (!composition?.inputs?.length) {
    return <p className="text-sm text-muted-foreground">Esta linha ainda nao possui composicao analitica vinculada.</p>;
  }

  return (
    <div className="overflow-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/60">
          <tr className="border-b border-border">
            <th className="px-2 py-1.5 text-left">Codigo</th>
            <th className="px-2 py-1.5 text-left">Banco</th>
            <th className="px-2 py-1.5 text-left">Descricao</th>
            <th className="px-2 py-1.5 text-center">Un</th>
            <th className="px-2 py-1.5 text-right">Coef.</th>
            <th className="px-2 py-1.5 text-right">Preco</th>
            <th className="px-2 py-1.5 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {composition.inputs.map(input => (
            <tr key={input.id} className="border-t border-border">
              <td className="px-2 py-1.5 font-mono">{input.code || '-'}</td>
              <td className="px-2 py-1.5">{input.bank || '-'}</td>
              <td className="px-2 py-1.5">{input.description}</td>
              <td className="px-2 py-1.5 text-center">{input.unit}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(input.coefficient)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtBRL(input.unitPrice)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtBRL(input.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QuantityView({ row }: { row: Row }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
      <div className="rounded-md border border-border bg-background px-3 py-2">
        <div className="text-[11px] text-muted-foreground">Qtd. contratada</div>
        <div className="text-sm font-semibold">{fmtNum(row.qtyContracted)}</div>
      </div>
      <div className="rounded-md border border-border bg-background px-3 py-2">
        <div className="text-[11px] text-muted-foreground">Qtd. medicao</div>
        <div className="text-sm font-semibold">{fmtNum(row.qtyPeriod)}</div>
      </div>
      <div className="rounded-md border border-border bg-background px-3 py-2">
        <div className="text-[11px] text-muted-foreground">Qtd. acumulada</div>
        <div className="text-sm font-semibold">{fmtNum(row.qtyCurrentAccum)}</div>
      </div>
      <div className="rounded-md border border-border bg-background px-3 py-2">
        <div className="text-[11px] text-muted-foreground">Qtd. a executar</div>
        <div className="text-sm font-semibold">{fmtNum(row.qtyBalance)}</div>
      </div>
      <p className="sm:col-span-4 text-xs text-muted-foreground">
        Na Medicao, a memoria e leitura: as quantidades vem dos apontamentos da EAP/Tarefas/Diario de Obra.
      </p>
    </div>
  );
}

function ClassificationView({
  project,
  row,
  composition,
  scope,
  bdi,
}: {
  project: Project;
  row: Row;
  composition?: AdditiveComposition;
  scope?: MeasurementValueScope;
  bdi: number;
}) {
  const values = scopeValues(row, scope);
  const breakdown = composition ? MC.getMaterialCompositionBreakdown(project, composition, 'Medicao') : null;
  const base = breakdown?.total ?? 0;
  const bdiValue = Math.max(0, values.withBdi - values.noBdi);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2">
        {(breakdown?.rows ?? []).map(item => {
          const proportional = base > 0 ? item.total * values.noBdi / base : 0;
          return (
            <div key={item.costClass} className="rounded-md border border-border bg-background px-3 py-2">
              <div className="text-[11px] text-muted-foreground">{item.label}</div>
              <div className="mt-1 text-sm font-semibold tabular-nums">{fmtBRL(proportional)}</div>
              <div className="text-[10px] text-muted-foreground">{item.itemsCount} insumo(s)</div>
            </div>
          );
        })}
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
          <div className="text-[11px] text-muted-foreground">BDI em reais</div>
          <div className="mt-1 text-sm font-semibold tabular-nums">{fmtBRL(bdiValue)}</div>
          <div className="text-[10px] text-muted-foreground">{bdi.toLocaleString('pt-BR')}% no orcamento</div>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        Base selecionada: <strong>{values.label}</strong> - {fmtBRL(values.withBdi)}
      </div>
      {!breakdown && (
        <p className="text-xs text-muted-foreground">
          Nao encontrei analitica vinculada para separar este valor por Material, Mao de obra e Equipamento.
        </p>
      )}
    </div>
  );
}

export default function MeasurementDetailFooter({ project, selection, row, bdi }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const fixedFooterStyle = {
    left: 'calc(var(--sidebar-width, 0px) + 1rem)',
    right: '1rem',
  } as const;
  const composition = findComposition(project, row);
  const title =
    selection?.mode === 'quantity' ? 'Memoria / quantidades da medicao'
    : selection?.mode === 'analytic' ? 'Composicao analitica'
    : selection?.mode === 'classification' ? 'Classificacao do valor total'
    : 'Detalhe da medicao';
  const Icon =
    selection?.mode === 'quantity' ? Calculator
    : selection?.mode === 'analytic' ? Layers
    : PieChart;

  return (
    <Card
      data-detail-footer="true"
      style={fixedFooterStyle}
      className="print:hidden fixed bottom-0 z-50 border-primary/20 overflow-hidden rounded-b-none rounded-t-xl shadow-2xl bg-background"
    >
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="w-4 h-4 text-primary" />
            {title}
          </div>
          {row && (
            <p className="mt-0.5 text-xs text-muted-foreground truncate">
              {row.item || 'Sem item'} - {row.itemCode || 'sem codigo'} - {row.description}
            </p>
          )}
        </div>
        <button
          type="button"
          className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          onClick={() => setCollapsed(v => !v)}
        >
          <ChevronDown className={`inline h-3.5 w-3.5 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
          <span className="ml-1">{collapsed ? 'Expandir' : 'Recolher'}</span>
        </button>
      </div>
      {!collapsed && (
        <div className="p-3 max-h-[38vh] overflow-auto">
          {!selection || !row ? (
            <div className="text-sm text-muted-foreground">
              Selecione uma quantidade, preco ou valor total para ver os detalhes.
            </div>
          ) : selection.mode === 'quantity' ? (
            <QuantityView row={row} />
          ) : selection.mode === 'analytic' ? (
            <AnalyticView composition={composition} />
          ) : (
            <ClassificationView project={project} row={row} composition={composition} scope={selection.valueScope} bdi={bdi} />
          )}
        </div>
      )}
    </Card>
  );
}
