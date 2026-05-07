import { Fragment, memo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AdditiveComposition, AdditiveCalculationMemoryRow } from '@/types/project';
import type { CompGroup } from './types';
import { fmtBRL, COL_COUNT } from './types';
import AdditiveCompositionRow from './AdditiveCompositionRow';

interface Props {
  group: CompGroup;
  bdi: number;
  globalDiscount: number;
  isLocked: boolean;
  expanded: Set<string>;
  expandedMemory: Set<string>;
  collapsed: Set<string>;
  showAnalytic: boolean;
  onToggleExpand: (id: string) => void;
  onToggleMemory: (id: string) => void;
  onToggleCollapsed: (id: string) => void;
  onUpdateComposition: (id: string, patch: Partial<AdditiveComposition>) => void;
  onUpdateQuantity: (id: string, field: 'addedQuantity' | 'suppressedQuantity', v: number) => void;
  onRemoveComposition: (id: string) => void;
  onAddNewService: (phaseId: string, phaseChain: string, parentNumber: string) => void;
  onChangeMemory: (id: string, rows: AdditiveCalculationMemoryRow[]) => void;
}

function AdditiveGroupRowImpl(props: Props) {
  const { group: g, isLocked, collapsed, onToggleCollapsed, onAddNewService } = props;
  const indent = g.depth * 14;
  const isCollapsed = collapsed.has(g.phaseId);

  return (
    <Fragment>
      <tr className="bg-primary/5 border-b border-primary/20 font-semibold">
        <td colSpan={COL_COUNT} className="px-2 py-1.5">
          <div className="flex items-center gap-2" style={{ paddingLeft: indent }}>
            <button
              type="button"
              onClick={() => onToggleCollapsed(g.phaseId)}
              className="inline-flex items-center justify-center w-4 h-4 hover:bg-primary/10 rounded"
              aria-label={isCollapsed ? 'Expandir' : 'Recolher'}
            >
              {isCollapsed
                ? <ChevronRight className="w-3.5 h-3.5" />
                : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            <span className="text-[12px]">{g.number} {g.name}</span>
          </div>
        </td>
      </tr>
      {!isCollapsed && g.rows.map(c => (
        <AdditiveCompositionRow
          key={c.id}
          c={c}
          bdi={props.bdi}
          globalDiscount={props.globalDiscount}
          isLocked={isLocked}
          isOpen={props.expanded.has(c.id)}
          isMemoryOpen={props.expandedMemory.has(c.id)}
          showAnalytic={props.showAnalytic}
          onToggleExpand={props.onToggleExpand}
          onToggleMemory={props.onToggleMemory}
          onUpdateComposition={props.onUpdateComposition}
          onUpdateQuantity={props.onUpdateQuantity}
          onRemoveComposition={props.onRemoveComposition}
          onChangeMemory={props.onChangeMemory}
        />
      ))}
      {!isCollapsed && !isLocked && (
        <tr className="border-b bg-sky-50/30">
          <td colSpan={COL_COUNT} className="px-2 py-1">
            <div style={{ paddingLeft: indent + 24 }}>
              <button
                type="button"
                onClick={() => onAddNewService(g.phaseId, `${g.number} ${g.name}`, g.number)}
                className="text-[11px] text-sky-700 hover:text-sky-900 hover:underline inline-flex items-center gap-1"
              >
                + Novo serviço em {g.number} {g.name}
              </button>
            </div>
          </td>
        </tr>
      )}
      {!isCollapsed && g.children.map(child => (
        <AdditiveGroupRow key={child.phaseId} {...props} group={child} />
      ))}
      <tr className="border-b bg-muted/30 font-medium">
        <td colSpan={13} className="px-2 py-1 text-right text-[11px]" style={{ paddingLeft: indent }}>
          Subtotal {g.number} {g.name}
        </td>
        <td className="px-2 py-1 text-right text-[11px]">{fmtBRL(g.subtotalContratado)}</td>
        <td colSpan={3} />
        <td className="px-2 py-1 text-right text-[11px]">{fmtBRL(g.subtotalFinal)}</td>
        <td colSpan={2} />
      </tr>
    </Fragment>
  );
}

const AdditiveGroupRow = memo(AdditiveGroupRowImpl);
export default AdditiveGroupRow;
