import { useState } from 'react';
import { Calculator, ChevronDown, Layers, PieChart } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { AdditiveCalculationMemoryRow, AdditiveComposition, Project } from '@/types/project';
import { computeAdditiveRow, computeCompositionWithBDI } from '@/lib/additiveImport';
import * as MC from '@/lib/materialComparisons';
import AdditiveAnalyticRows from './AdditiveAnalyticRows';
import AdditiveCalculationMemory from './AdditiveCalculationMemory';
import { fmtBRL } from './types';

export type AdditiveDetailMode = 'memory' | 'analytic' | 'classification';

export interface AdditiveDetailSelection {
  compositionId: string;
  mode: AdditiveDetailMode;
  qtyType?: 'acrescida' | 'suprimida';
}

interface Props {
  project: Project;
  selection: AdditiveDetailSelection | null;
  composition?: AdditiveComposition;
  bdi: number;
  globalDiscount: number;
  isLocked: boolean;
  onChangeMemory: (id: string, rows: AdditiveCalculationMemoryRow[]) => void;
  onUpdateComposition: (id: string, patch: Partial<AdditiveComposition>) => void;
}

function EmptyState() {
  return (
    <div className="text-sm text-muted-foreground">
      Clique em uma quantidade, preço ou valor total para ver os detalhes da composição neste rodapé.
    </div>
  );
}

function ClassificationView({
  project,
  composition,
  bdi,
  globalDiscount,
}: {
  project: Project;
  composition: AdditiveComposition;
  bdi: number;
  globalDiscount: number;
}) {
  const row = computeAdditiveRow(composition, bdi, globalDiscount);
  const breakdown = MC.getMaterialCompositionBreakdown(project, composition, 'Aditivo');
  const bdiValue = Math.max(0, (row.unitPriceWithBDI - row.unitPriceNoBDIWithDiscount) * row.qtdFinal);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2">
        {(breakdown?.rows ?? []).map(item => (
          <div key={item.costClass} className="rounded-md border border-border bg-background px-3 py-2">
            <div className="text-[11px] text-muted-foreground">{item.label}</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{fmtBRL(item.total)}</div>
            <div className="text-[10px] text-muted-foreground">{item.itemsCount} insumo(s)</div>
          </div>
        ))}
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
          <div className="text-[11px] text-muted-foreground">BDI em reais</div>
          <div className="mt-1 text-sm font-semibold tabular-nums">{fmtBRL(bdiValue)}</div>
          <div className="text-[10px] text-muted-foreground">{bdi.toLocaleString('pt-BR')}% sobre a base</div>
        </div>
      </div>
      {!breakdown && (
        <p className="text-xs text-muted-foreground">
          Esta composição ainda não tem analítica suficiente para separar Material, Mão de obra e Equipamento.
        </p>
      )}
    </div>
  );
}

export default function AdditiveDetailFooter({
  project,
  selection,
  composition,
  bdi,
  globalDiscount,
  isLocked,
  onChangeMemory,
  onUpdateComposition,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const title =
    selection?.mode === 'memory' ? 'Memória de cálculo'
    : selection?.mode === 'analytic' ? 'Composição analítica'
    : selection?.mode === 'classification' ? 'Classificação do valor total'
    : 'Detalhe da composição';
  const Icon =
    selection?.mode === 'memory' ? Calculator
    : selection?.mode === 'analytic' ? Layers
    : PieChart;

  return (
    <Card data-detail-footer="true" className="print:hidden sticky bottom-3 z-30 border-primary/20 overflow-hidden shadow-xl bg-background">
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="w-4 h-4 text-primary" />
            {title}
          </div>
          {composition && (
            <p className="mt-0.5 text-xs text-muted-foreground truncate">
              {composition.itemNumber || composition.item || 'Sem item'} · {composition.code || 'sem código'} · {composition.description}
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
      {!collapsed && <div className="p-3 max-h-[320px] overflow-auto">
        {!selection || !composition ? (
          <EmptyState />
        ) : selection.mode === 'memory' ? (
          <AdditiveCalculationMemory
            c={composition}
            isLocked={isLocked}
            onChange={rows => onChangeMemory(composition.id, rows)}
            onChangeColumns={cols => onUpdateComposition(composition.id, { calculationMemoryColumns: cols })}
          />
        ) : selection.mode === 'analytic' ? (
          <AdditiveAnalyticRows
            c={composition}
            bdi={bdi}
            globalDiscount={globalDiscount}
            isLocked={isLocked}
            cb={computeCompositionWithBDI(composition, bdi)}
            onUpdateComposition={onUpdateComposition}
          />
        ) : (
          <ClassificationView project={project} composition={composition} bdi={bdi} globalDiscount={globalDiscount} />
        )}
      </div>}
    </Card>
  );
}
