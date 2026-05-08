import { Card } from '@/components/ui/card';
import type { AdditiveComposition, AdditiveCalculationMemoryRow } from '@/types/project';
import type { CompGroup } from './types';
import { COL_COUNT, G_HEAD, BORDER_L } from './types';
import AdditiveGroupRow from './AdditiveGroupRow';
import AdditiveCompositionRow from './AdditiveCompositionRow';

interface Props {
  bdi: number;
  globalDiscount: number;
  isLocked: boolean;
  showAnalytic: boolean;
  expanded: Set<string>;
  expandedMemory: Set<string>;
  collapsed: Set<string>;
  filteredComps: AdditiveComposition[];
  groupTree: CompGroup[];
  orphanRows: AdditiveComposition[];
  hasEapLink: boolean;
  onToggleExpand: (id: string) => void;
  onToggleMemory: (id: string) => void;
  onToggleCollapsed: (id: string) => void;
  onUpdateComposition: (id: string, patch: Partial<AdditiveComposition>) => void;
  onUpdateQuantity: (id: string, field: 'addedQuantity' | 'suppressedQuantity', v: number) => void;
  onRemoveComposition: (id: string) => void;
  onAddNewService: (phaseId: string, phaseChain: string, parentNumber: string) => void;
  onChangeMemory: (id: string, rows: AdditiveCalculationMemoryRow[]) => void;
}

export default function AdditiveTable(props: Props) {
  const { filteredComps, groupTree, orphanRows, hasEapLink } = props;

  const renderRow = (c: AdditiveComposition, idx: number) => (
    <AdditiveCompositionRow
      key={c.id}
      c={c}
      bdi={props.bdi}
      globalDiscount={props.globalDiscount}
      isLocked={props.isLocked}
      isOpen={props.expanded.has(c.id)}
      isMemoryOpen={props.expandedMemory.has(c.id)}
      showAnalytic={props.showAnalytic}
      rowIndex={idx}
      onToggleExpand={props.onToggleExpand}
      onToggleMemory={props.onToggleMemory}
      onUpdateComposition={props.onUpdateComposition}
      onUpdateQuantity={props.onUpdateQuantity}
      onRemoveComposition={props.onRemoveComposition}
      onChangeMemory={props.onChangeMemory}
    />
  );

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse" style={{ minWidth: 1280, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 22 }} />
            <col style={{ width: 44 }} />
            <col style={{ width: 60 }} />
            <col style={{ width: 70 }} />
            <col style={{ width: 240 }} />
            <col style={{ width: 36 }} />
            <col style={{ width: 62 }} />
            <col style={{ width: 62 }} />
            <col style={{ width: 62 }} />
            <col style={{ width: 54 }} />
            <col style={{ width: 68 }} />
            <col style={{ width: 74 }} />
            <col style={{ width: 74 }} />
            <col style={{ width: 78 }} />
            <col style={{ width: 78 }} />
            <col style={{ width: 78 }} />
            <col style={{ width: 78 }} />
            <col style={{ width: 74 }} />
            <col style={{ width: 48 }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <th />
              <th colSpan={5} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-center ${G_HEAD.id}`}>
                Identificação
              </th>
              <th colSpan={4} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-center ${G_HEAD.qty} ${BORDER_L}`}>
                Quantidades
              </th>
              <th colSpan={4} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-center ${G_HEAD.val} ${BORDER_L}`}>
                Valores
              </th>
              <th colSpan={5} className={`px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-center ${G_HEAD.impact} ${BORDER_L}`}>
                Impacto do Aditivo
              </th>
            </tr>
            <tr className="bg-muted/60 border-b">
              <th className="w-8" />
              <th className="px-1 py-1.5 text-left font-semibold">Item</th>
              <th className="px-1 py-1.5 text-left font-semibold">Código</th>
              <th className="px-1 py-1.5 text-left font-semibold">Banco</th>
              <th className="px-1 py-1.5 text-left font-semibold">Descrição</th>
              <th className="px-1 py-1.5 text-left font-semibold">Und</th>
              <th className={`px-1 py-1.5 text-right font-semibold ${BORDER_L}`}>Qtd Contratada</th>
              <th className="px-1 py-1.5 text-right font-semibold text-rose-700 bg-rose-50">Qtd Suprimida</th>
              <th className="px-1 py-1.5 text-right font-semibold text-emerald-700 bg-emerald-50">Qtd Acrescida</th>
              <th className="px-1 py-1.5 text-right font-semibold">Qtd Final</th>
              <th className={`px-1 py-1.5 text-right font-semibold ${BORDER_L}`}>Valor Unit</th>
              <th className="px-1 py-1.5 text-right font-semibold">Valor Unit c/ BDI</th>
              <th className="px-1 py-1.5 text-right font-semibold">Total Fonte</th>
              <th className="px-1 py-1.5 text-right font-semibold">Valor Contratado</th>
              <th className={`px-1 py-1.5 text-right font-semibold text-rose-700 bg-rose-50 ${BORDER_L}`}>Valor Suprimido</th>
              <th className="px-1 py-1.5 text-right font-semibold text-emerald-700 bg-emerald-50">Valor Acrescido</th>
              <th className="px-1 py-1.5 text-right font-semibold">Valor Final</th>
              <th className="px-1 py-1.5 text-right font-semibold">Diferença</th>
              <th className="px-1 py-1.5 text-right font-semibold">% Var.</th>
            </tr>
          </thead>
          <tbody>
            {filteredComps.length === 0 ? (
              <tr>
                <td colSpan={COL_COUNT} className="text-center text-muted-foreground py-8">
                  Nenhuma composição encontrada com os filtros atuais.
                </td>
              </tr>
            ) : !hasEapLink ? (
              filteredComps.map(renderRow)
            ) : (
              <>
                {groupTree.map(g => (
                  <AdditiveGroupRow
                    key={g.phaseId}
                    group={g}
                    bdi={props.bdi}
                    globalDiscount={props.globalDiscount}
                    isLocked={props.isLocked}
                    expanded={props.expanded}
                    expandedMemory={props.expandedMemory}
                    collapsed={props.collapsed}
                    showAnalytic={props.showAnalytic}
                    onToggleExpand={props.onToggleExpand}
                    onToggleMemory={props.onToggleMemory}
                    onToggleCollapsed={props.onToggleCollapsed}
                    onUpdateComposition={props.onUpdateComposition}
                    onUpdateQuantity={props.onUpdateQuantity}
                    onRemoveComposition={props.onRemoveComposition}
                    onAddNewService={props.onAddNewService}
                    onChangeMemory={props.onChangeMemory}
                  />
                ))}
                {orphanRows.length > 0 && (
                  <>
                    <tr className="bg-amber-50 border-b border-amber-200 font-semibold">
                      <td colSpan={COL_COUNT} className="px-2 py-1.5 text-amber-900 text-[12px]">
                        Itens da Sintética sem vínculo na EAP
                      </td>
                    </tr>
                    {orphanRows.map(renderRow)}
                  </>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
