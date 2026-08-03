import { Fragment, memo } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { AdditiveComposition, AdditiveCalculationMemoryRow, AdditiveInput, Project } from '@/types/project';
import type { CompGroup } from './types';
import { fmtBRL, fmtPct, COL_COUNT } from './types';
import AdditiveCompositionRow from './AdditiveCompositionRow';
import type { AdditiveDetailSelection } from './AdditiveDetailFooter';

interface Props {
  project: Project;
  group: CompGroup;
  bdi: number;
  globalDiscount: number;
  isLocked: boolean;
  expanded: Set<string>;
  collapsed: Set<string>;
  showAnalytic: boolean;
  onToggleExpand: (id: string) => void;
  onToggleCollapsed: (id: string) => void;
  onUpdateComposition: (id: string, patch: Partial<AdditiveComposition>) => void;
  onReorderComposition: (id: string, requestedItem: string) => void;
  onUpdateQuantity: (id: string, field: 'addedQuantity' | 'suppressedQuantity', v: number) => void;
  onRemoveComposition: (id: string) => void;
  onAddNewService: (phaseId: string, phaseChain: string, parentNumber: string) => void;
  onAddNewSubchapter: (parentPhaseId: string) => void;
  onChangeMemory: (id: string, rows: AdditiveCalculationMemoryRow[]) => void;
  selectedDetail?: AdditiveDetailSelection | null;
  onSelectDetail?: (selection: AdditiveDetailSelection | null) => void;
  inputReferenceByCode?: ReadonlyMap<string, AdditiveInput>;
}

function AdditiveGroupRowImpl(props: Props) {
  const { group: g, isLocked, collapsed, onToggleCollapsed, onAddNewService, onAddNewSubchapter } = props;
  const indent = g.depth * 14;
  const isCollapsed = collapsed.has(g.phaseId);

  const pctVar = g.subtotalContratado > 0 ? g.subtotalDiferenca / g.subtotalContratado : 0;
  const bgByDepth = g.depth === 0 ? 'bg-primary/10' : 'bg-primary/5';

  return (
    <Fragment>
      <tr
        className={`${bgByDepth} border-b border-primary/20 font-semibold cursor-pointer hover:bg-primary/15`}
        onClick={() => onToggleCollapsed(g.phaseId)}
      >
        {/* chevron col */}
        <td className="px-1 py-1.5 align-middle">
          <span className="inline-flex items-center justify-center w-4 h-4">
            {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </span>
        </td>
        {/* Item */}
        <td className="px-1 py-1.5 text-[12px]" style={{ paddingLeft: indent + 4 }}>{g.number}</td>
        {/* Código */}
        <td />
        {/* Banco */}
        <td />
        {/* Descrição */}
        <td className="px-1 py-1.5 text-[12px]" title={g.name}>
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate">{g.name}</span>
            {g.depth === 0 && !isLocked && (
              <button
                type="button"
                aria-label={`Novo subcapítulo em ${g.number} ${g.name}`}
                title="Novo subcapítulo"
                onClick={event => {
                  event.stopPropagation();
                  onAddNewSubchapter(g.phaseId);
                }}
                className="inline-flex shrink-0 items-center rounded p-0.5 text-sky-700 hover:bg-sky-100 hover:text-sky-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </td>
        {/* Und */}
        <td />
        {/* Quantidades (4) */}
        <td /><td /><td /><td />
        {/* Valor Unit / Valor Unit c/ BDI */}
        <td /><td />
        {/* Total Fonte */}
        <td className="px-1 py-1.5 text-center text-[12px]">{fmtBRL(g.subtotalTotalFonte)}</td>
        {/* Valor Contratado */}
        <td className="px-1 py-1.5 text-center text-[12px]">{fmtBRL(g.subtotalContratado)}</td>
        {/* Valor Suprimido */}
        <td className="px-1 py-1.5 text-center text-[12px] bg-rose-50 text-rose-700">
          {g.subtotalSuprimido ? fmtBRL(g.subtotalSuprimido) : ''}
        </td>
        {/* Valor Acrescido */}
        <td className="px-1 py-1.5 text-center text-[12px] bg-emerald-50 text-emerald-700">
          {g.subtotalAcrescido ? fmtBRL(g.subtotalAcrescido) : ''}
        </td>
        {/* Valor Final */}
        <td className="px-1 py-1.5 text-center text-[12px] font-bold">{fmtBRL(g.subtotalFinal)}</td>
        {/* Diferença */}
        <td className={`px-1 py-1.5 text-center text-[12px] ${g.subtotalDiferenca < 0 ? 'text-rose-700' : g.subtotalDiferenca > 0 ? 'text-emerald-700' : ''}`}>
          {g.subtotalDiferenca ? fmtBRL(g.subtotalDiferenca) : ''}
        </td>
        {/* % Var */}
        <td className={`px-1 py-1.5 text-center text-[12px] ${pctVar < 0 ? 'text-rose-700' : pctVar > 0 ? 'text-emerald-700' : ''}`}>
          {pctVar ? fmtPct(pctVar) : ''}
        </td>
      </tr>
      {!isCollapsed && g.rows.map((c, idx) => (
        <AdditiveCompositionRow
          key={c.id}
          project={props.project}
          c={c}
          bdi={props.bdi}
          globalDiscount={props.globalDiscount}
          isLocked={isLocked}
          isOpen={props.expanded.has(c.id)}
          isMemoryOpen={props.selectedDetail?.compositionId === c.id && props.selectedDetail.mode === 'memory'}
          showAnalytic={props.showAnalytic}
          rowIndex={idx}
          onToggleExpand={props.onToggleExpand}
          onUpdateComposition={props.onUpdateComposition}
          onReorderComposition={props.onReorderComposition}
          onUpdateQuantity={props.onUpdateQuantity}
          onRemoveComposition={props.onRemoveComposition}
          onChangeMemory={props.onChangeMemory}
          selectedDetail={props.selectedDetail}
          onSelectDetail={props.onSelectDetail}
          inputReferenceByCode={props.inputReferenceByCode}
        />
      ))}
      {!isCollapsed && !isLocked && (
        <tr className="border-b bg-sky-50/30">
          <td colSpan={COL_COUNT} className="px-2 py-1">
            <div style={{ paddingLeft: 24 }}>
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
    </Fragment>
  );
}

const AdditiveGroupRow = memo(AdditiveGroupRowImpl);
export default AdditiveGroupRow;
