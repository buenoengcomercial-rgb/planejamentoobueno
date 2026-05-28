import { Fragment } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { GroupNode } from '@/components/measurement/types';
import { fmtBRL } from '@/components/measurement/measurementFormat';
import MeasurementItemRow, { type MeasurementItemRowProps } from './MeasurementItemRow';

type RowHandlers = Omit<MeasurementItemRowProps, 'row' | 'indentPx' | 'G_BG' | 'BORDER_L'>;

interface MeasurementGroupRowProps extends RowHandlers {
  group: GroupNode;
  collapsed: Set<string>;
  toggleCollapsed: (id: string) => void;
  G_BG: MeasurementItemRowProps['G_BG'];
  BORDER_L: string;
  headerStyleByDepth: (depth: number) => string;
}

export default function MeasurementGroupRow(props: MeasurementGroupRowProps) {
  const {
    group: g,
    collapsed,
    toggleCollapsed,
    G_BG,
    BORDER_L,
    headerStyleByDepth,
    ...rowHandlers
  } = props;

  const indentPx = g.depth * 14;
  const isCollapsed = collapsed.has(g.phaseId);

  return (
    <Fragment>
      {/* Ordem contratual/original: a Medicao deve exibir totais no proprio nivel hierarquico. */}
      <tr
        className={`${headerStyleByDepth(g.depth)} cursor-pointer hover:bg-primary/15`}
        onClick={() => toggleCollapsed(g.phaseId)}
      >
        <td colSpan={8} className="px-2 py-1.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              toggleCollapsed(g.phaseId);
            }}
            className="inline-flex items-center gap-1 hover:opacity-80 print-hide"
            style={{ paddingLeft: indentPx }}
          >
            {isCollapsed
              ? <ChevronRight className="w-3.5 h-3.5" />
              : <ChevronDown className="w-3.5 h-3.5" />}
            <span className="font-mono tabular-nums">{g.number}</span>
            <span className="ml-1 uppercase tracking-wide">{g.name}</span>
          </button>
          <span className="hidden print:inline font-mono tabular-nums" style={{ paddingLeft: indentPx }}>
            {g.number} {g.name}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{fmtBRL(g.totals.contracted)}</td>
        <td className={`px-2 py-1.5 text-right tabular-nums text-foreground ${BORDER_L}`}>-</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{fmtBRL(g.totals.period)}</td>
        <td className={`px-2 py-1.5 text-right tabular-nums text-foreground ${BORDER_L}`}>-</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{fmtBRL(g.totals.forecast)}</td>
        <td className={`px-2 py-1.5 text-right tabular-nums ${g.totals.diffForecast > 0 ? 'text-success' : g.totals.diffForecast < 0 ? 'text-destructive' : 'text-foreground'}`}>
          {fmtBRL(g.totals.diffForecast)}
        </td>
        <td className={`px-2 py-1.5 text-right tabular-nums text-foreground ${BORDER_L}`}>-</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{fmtBRL(g.totals.accum)}</td>
        <td className={`px-2 py-1.5 text-right tabular-nums text-foreground ${BORDER_L}`}>-</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{fmtBRL(g.totals.balance)}</td>
      </tr>

      {!isCollapsed && (
        <Fragment>
          {g.rows.map(r => (
            <MeasurementItemRow
              key={r.taskId}
              row={r}
              indentPx={indentPx}
              G_BG={G_BG}
              BORDER_L={BORDER_L}
              {...rowHandlers}
            />
          ))}
          {g.children.map(child => (
            <MeasurementGroupRow
              key={child.phaseId}
              group={child}
              collapsed={collapsed}
              toggleCollapsed={toggleCollapsed}
              G_BG={G_BG}
              BORDER_L={BORDER_L}
              headerStyleByDepth={headerStyleByDepth}
              {...rowHandlers}
            />
          ))}
        </Fragment>
      )}
    </Fragment>
  );
}
