import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import type { AdditiveComposition, AdditiveCalculationMemoryRow, AdditiveInput } from '@/types/project';
import type { CompGroup } from './types';
import { COL_COUNT, G_HEAD, BORDER_L } from './types';
import AdditiveGroupRow from './AdditiveGroupRow';
import AdditiveCompositionRow from './AdditiveCompositionRow';
import type { AdditiveDetailSelection } from './AdditiveDetailFooter';

interface Props {
  bdi: number;
  globalDiscount: number;
  isLocked: boolean;
  showAnalytic: boolean;
  expanded: Set<string>;
  expandedMemory: Set<string>;
  collapsed: Set<string>;
  filteredComps: AdditiveComposition[];
  allCompositions?: AdditiveComposition[];
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
  selectedDetail?: AdditiveDetailSelection | null;
  onSelectDetail?: (selection: AdditiveDetailSelection) => void;
}

const normalizeInputCode = (value: string) => value.trim().toUpperCase();

const inputReferenceScore = (input: AdditiveInput) =>
  (input.bank ? 1 : 0) +
  (input.description ? 3 : 0) +
  (input.unit ? 1 : 0) +
  ((input.unitPrice ?? 0) > 0 ? 3 : 0);

export default function AdditiveTable(props: Props) {
  const { filteredComps, allCompositions, groupTree, orphanRows, hasEapLink } = props;
  const inputReferenceByCode = useMemo(() => {
    const references = new Map<string, AdditiveInput>();
    for (const composition of allCompositions ?? filteredComps) {
      for (const input of composition.inputs ?? []) {
        const code = normalizeInputCode(input.code ?? '');
        if (!code) continue;
        const current = references.get(code);
        if (!current || inputReferenceScore(input) > inputReferenceScore(current)) {
          references.set(code, input);
        }
      }
    }
    return references;
  }, [allCompositions, filteredComps]);

  const renderRow = (c: AdditiveComposition, idx: number) => (
    <AdditiveCompositionRow
      key={c.id}
      c={c}
      bdi={props.bdi}
      globalDiscount={props.globalDiscount}
      isLocked={props.isLocked}
      isOpen={props.expanded.has(c.id)}
      isMemoryOpen={props.selectedDetail?.compositionId === c.id && props.selectedDetail.mode === 'memory'}
      showAnalytic={props.showAnalytic}
      rowIndex={idx}
      onToggleExpand={props.onToggleExpand}
      onToggleMemory={props.onToggleMemory}
      onUpdateComposition={props.onUpdateComposition}
      onUpdateQuantity={props.onUpdateQuantity}
      onRemoveComposition={props.onRemoveComposition}
      onChangeMemory={props.onChangeMemory}
      selectedDetail={props.selectedDetail}
      onSelectDetail={props.onSelectDetail}
      inputReferenceByCode={inputReferenceByCode}
    />
  );

  return (
    <Card className="overflow-hidden w-full">
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] border-collapse [&_thead_th]:whitespace-nowrap" style={{ minWidth: 1640, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 22 }} />
            <col style={{ width: 44 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 290 }} />
            <col style={{ width: 42 }} />
            <col style={{ width: 86 }} />
            <col style={{ width: 86 }} />
            <col style={{ width: 86 }} />
            <col style={{ width: 72 }} />
            <col style={{ width: 92 }} />
            <col style={{ width: 104 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 112 }} />
            <col style={{ width: 104 }} />
            <col style={{ width: 112 }} />
            <col style={{ width: 104 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 70 }} />
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
                    selectedDetail={props.selectedDetail}
                    onSelectDetail={props.onSelectDetail}
                    inputReferenceByCode={inputReferenceByCode}
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
