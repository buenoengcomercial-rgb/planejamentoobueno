import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Project, Subcontract } from '@/types/project';
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
  Plus,
  ReceiptText,
  History,
  Undo2,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  buildRealCostAnalysis,
  type RealCostCompositionRow,
  type RealCostGroupNode,
  type RealCostGroupTotals,
  type RealCostSignal,
} from '@/lib/realCost';
import { fmtBRL, fmtPct } from '@/components/measurement/measurementFormat';
import { loadObraConfig } from '@/components/ConfiguracaoObra';
import { Button } from '@/components/ui/button';
import { logToProject, type AuditUserInfo } from '@/lib/audit';
import { allocateSubcontractValue, freezeSubcontractPayments, subcontractBalance, subcontractExecutedQuantity, subcontractPaidValue } from '@/lib/subcontracts';

interface Props {
  project: Project;
  onProjectChange: (project: Project) => void;
  canManageSubcontracts: boolean;
  canDeleteSubcontractHistory?: boolean;
  auditActor?: AuditUserInfo;
}

const SIGNAL_META: Record<RealCostSignal, { label: string; cls: string; dot: string }> = {
  healthy: {
    label: 'Saudável',
    cls: 'border-success/35 bg-success/10 text-success',
    dot: 'bg-success',
  },
  attention: {
    label: 'Atenção',
    cls: 'border-warning/40 bg-warning/10 text-warning',
    dot: 'bg-warning',
  },
  danger: {
    label: 'Crítico',
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

function signalFromTotals(totals: Pick<RealCostGroupTotals, 'certifiedContractedValue' | 'pendingCompositionCount' | 'marginPct'>): RealCostSignal {
  if (totals.pendingCompositionCount > 0 || totals.certifiedContractedValue <= 0) return 'incomplete';
  if (totals.marginPct < 5) return 'danger';
  if (totals.marginPct < 15) return 'attention';
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

function fmtQty(value: number) {
  return (Number(value) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

function roundMoney(value: number) {
  return Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;
}

function computeVisibleTotals(rows: RealCostCompositionRow[], children: RealCostGroupNode[]): RealCostGroupTotals {
  const contractedValue = roundMoney(
    rows.reduce((sum, row) => sum + row.contractedValue, 0) +
    children.reduce((sum, child) => sum + child.totals.contractedValue, 0),
  );
  const realCost = roundMoney(
    rows.reduce((sum, row) => sum + row.realCost, 0) +
    children.reduce((sum, child) => sum + child.totals.realCost, 0),
  );
  const materialCost = roundMoney(
    rows.reduce((sum, row) => sum + row.materialCost, 0) +
    children.reduce((sum, child) => sum + child.totals.materialCost, 0),
  );
  const laborCost = roundMoney(
    rows.reduce((sum, row) => sum + row.laborCost, 0) +
    children.reduce((sum, child) => sum + child.totals.laborCost, 0),
  );
  const contractedLaborCost = roundMoney(
    rows.reduce((sum, row) => sum + row.contractedLaborCost, 0) +
    children.reduce((sum, child) => sum + child.totals.contractedLaborCost, 0),
  );
  const certifiedContractedValue = roundMoney(
    rows.filter(row => row.isCertified).reduce((sum, row) => sum + row.contractedValue, 0) +
    children.reduce((sum, child) => sum + child.totals.certifiedContractedValue, 0),
  );
  const equipmentCost = roundMoney(
    rows.reduce((sum, row) => sum + row.equipmentCost, 0) +
    children.reduce((sum, child) => sum + child.totals.equipmentCost, 0),
  );
  const otherCost = roundMoney(
    rows.reduce((sum, row) => sum + row.otherCost, 0) +
    children.reduce((sum, child) => sum + child.totals.otherCost, 0),
  );
  const committedCost = roundMoney(
    rows.filter(row => row.isCertified).reduce((sum, row) => sum + row.committedCost, 0) +
    children.reduce((sum, child) => sum + child.totals.committedCost, 0),
  );
  const grossProfit = roundMoney(certifiedContractedValue - committedCost);
  const marginPct = certifiedContractedValue > 0 ? Math.round((grossProfit / certifiedContractedValue) * 10000) / 100 : 0;
  const compositionCount = rows.length + children.reduce((sum, child) => sum + child.totals.compositionCount, 0);
  const pendingCompositionCount =
    rows.filter(row => row.signal === 'incomplete').length +
    children.reduce((sum, child) => sum + child.totals.pendingCompositionCount, 0);
  const totals = {
    contractedValue,
    certifiedContractedValue,
    materialCost,
    laborCost,
    contractedLaborCost,
    equipmentCost,
    otherCost,
    committedCost,
    realCost,
    grossProfit,
    marginPct,
    compositionCount,
    pendingCompositionCount,
    signal: 'incomplete' as RealCostSignal,
  };
  totals.signal = signalFromTotals(totals);
  return totals;
}

function groupHeaderStyle(depth: number) {
  if (depth === 0) return 'bg-primary/10 text-foreground font-bold border-y border-primary/30';
  if (depth === 1) return 'bg-slate-100/90 text-foreground font-semibold border-y border-border';
  return 'bg-slate-50 text-foreground font-semibold border-y border-border';
}

function collectGroupIds(groups: RealCostGroupNode[]) {
  const ids: string[] = [];
  const walk = (group: RealCostGroupNode) => {
    ids.push(group.phaseId);
    group.children.forEach(walk);
  };
  groups.forEach(walk);
  return ids;
}

const TABLE_COLSPAN = 17;
const BORDER_L = 'border-l-2 border-border';

function RealCostCompositionDetail({ row }: { row: RealCostCompositionRow }) {
  return (
    <tr className="border-b border-border bg-primary/5">
      <td colSpan={TABLE_COLSPAN} className="px-3 py-2">
        {row.subcontract && (
          <div className="mb-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
            <div className="font-semibold text-primary">Mão de obra terceirizada · {row.subcontract.name} ({row.subcontract.contractorName})</div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              <span>Referência: {fmtBRL(row.subcontract.referenceLaborCost)}</span><span>Contratado: {fmtBRL(row.subcontract.contractedAmount)}</span><span>Pago: {fmtBRL(row.subcontract.paidAmount)}</span><span>Saldo: {fmtBRL(row.subcontract.balance)}</span>
            </div>
            {row.subcontract.reconciliationIssue && <p className="mt-1 text-warning">{row.subcontract.reconciliationIssue}</p>}
          </div>
        )}
        <div className="overflow-hidden rounded-md border border-border/70 bg-background">
          {row.inputs.length === 0 ? (
            <div className="p-4 text-center text-[11px] text-muted-foreground">
              Composicao sem analitica vinculada. Ela continua na planilha, mas a margem fica incompleta.
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full min-w-[1180px] table-fixed border-collapse text-[11px]">
                <colgroup>
                  <col className="w-[82px]" />
                  <col className="w-[70px]" />
                  <col />
                  <col className="w-[54px]" />
                  <col className="w-[76px]" />
                  <col className="w-[88px]" />
                  <col className="w-[98px]" /><col className="w-[98px]" />
                  <col className="w-[98px]" />
                  <col className="w-[104px]" />
                  <col className="w-[76px]" />
                  <col className="w-[118px]" />
                  <col className="w-[118px]" />
                  <col className="w-[82px]" />
                  <col className="w-[82px]" />
                </colgroup>
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Codigo</th>
                    <th className="px-2 py-1.5 text-left">Banco</th>
                    <th className="px-2 py-1.5 text-left">Insumo</th>
                    <th className="px-2 py-1.5 text-center">Un.</th>
                    <th className="px-2 py-1.5 text-right">Coef.</th>
                    <th className="px-2 py-1.5 text-right">Qtd. total</th>
                    <th className="px-2 py-1.5 text-right">V. unit ref.</th>
                      <th className="px-2 py-1.5 text-right">Menor preço</th>
                      <th className="px-2 py-1.5 text-right">Total</th>
                    <th className="px-2 py-1.5 text-right">Margem</th>
                    <th className="px-2 py-1.5 text-left">Fornecedor</th>
                    <th className="px-2 py-1.5 text-left">Grupo</th>
                    <th className="px-2 py-1.5 text-center">Data</th>
                    <th className="px-2 py-1.5 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {row.inputs.map(input => (
                    <tr key={input.id} className="border-t border-border/60">
                      <td className="px-2 py-1.5 align-top font-mono text-[10px]">{input.code || '-'}</td>
                      <td className="px-2 py-1.5 align-top text-muted-foreground">{input.bank || '-'}</td>
                      <td className="px-2 py-1.5 align-top">
                        <div className="font-medium leading-snug">{input.description}</div>
                        {!input.priceSource && (
                          <div className="mt-1 text-[10px] text-warning">Sem cotacao na Lista de Material.</div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 align-top text-center">{input.unit}</td>
                      <td className="px-2 py-1.5 align-top text-right tabular-nums">{input.coefficient.toLocaleString('pt-BR', { minimumFractionDigits: 7, maximumFractionDigits: 7 })}</td>
                      <td className="px-2 py-1.5 align-top text-right tabular-nums">{fmtQty(input.totalQuantity)}</td>
                      <td className="px-2 py-1.5 align-top text-right tabular-nums">{fmtBRL(input.referenceUnitPrice)}</td>
                      <td className="px-2 py-1.5 align-top text-right tabular-nums">{input.priceSource ? fmtBRL(input.priceSource.unitPrice) : '-'}</td>
                      <td className="px-2 py-1.5 align-top text-right tabular-nums font-semibold">{input.priceSource ? fmtBRL(input.realTotal) : '-'}</td>
                      <td className={`px-2 py-1.5 align-top text-right tabular-nums font-semibold ${input.priceSource ? marginTone(input.marginPct) : 'text-muted-foreground'}`}>
                        {input.priceSource ? fmtPct(input.marginPct) : '-'}
                      </td>
                      <td className="px-2 py-1.5 align-top">{input.priceSource?.supplierName || '-'}</td>
                      <td className="px-2 py-1.5 align-top">{input.priceSource?.comparisonName || '-'}</td>
                      <td className="px-2 py-1.5 align-top text-center">{formatDate(input.priceSource?.date)}</td>
                      <td className="px-2 py-1.5 align-top text-center">
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
  );
}

function RealCostGroupRows({
  group,
  collapsed,
  toggleCollapsed,
  expandedId,
  setExpandedId,
}: {
  group: RealCostGroupNode;
  collapsed: Set<string>;
  toggleCollapsed: (id: string) => void;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  const isCollapsed = collapsed.has(group.phaseId);
  const indentPx = group.depth * 14;

  return (
    <Fragment>
      <tr className={groupHeaderStyle(group.depth)}>
        <td colSpan={8} className="px-2 py-1.5">
          <button
            type="button"
            onClick={() => toggleCollapsed(group.phaseId)}
            className="inline-flex items-center gap-1 hover:opacity-80"
            style={{ paddingLeft: indentPx }}
          >
            {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            <span className="font-mono tabular-nums">{group.number}</span>
            <span className="ml-1 uppercase tracking-wide">{group.name}</span>
            <span className="ml-2 text-[10px] font-medium text-muted-foreground">
              {group.totals.compositionCount} composição(ões)
            </span>
          </button>
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">{fmtBRL(group.totals.contractedValue)}</td>
        <td className={`px-2 py-1.5 text-right tabular-nums ${BORDER_L}`}>{fmtBRL(group.totals.materialCost)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">{fmtBRL(group.totals.laborCost)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-primary">{fmtBRL(group.totals.contractedLaborCost)}</td>
        <td className={`px-2 py-1.5 text-right tabular-nums ${BORDER_L}`}>{fmtBRL(group.totals.committedCost)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">{fmtBRL(group.totals.realCost)}</td>
        <td
          className={`px-2 py-1.5 text-right tabular-nums ${group.totals.signal === 'incomplete' ? 'text-warning' : group.totals.grossProfit >= 0 ? 'text-success' : 'text-destructive'}`}
        >
          {group.totals.certifiedContractedValue > 0 ? fmtBRL(group.totals.grossProfit) : '—'}
        </td>
        <td
          className={`px-2 py-1.5 text-right tabular-nums ${group.totals.signal === 'incomplete' ? 'text-warning' : marginTone(group.totals.marginPct)}`}
        >
          {group.totals.certifiedContractedValue > 0 ? fmtPct(group.totals.marginPct) : '—'}
        </td>
        <td className="px-2 py-1.5 text-center tabular-nums">{group.totals.pendingCompositionCount}</td>
        <td className="px-2 py-1.5 text-center"><SignalBadge signal={group.totals.signal} /></td>
      </tr>

      {!isCollapsed && (
        <Fragment>
          {group.rows.map(row => {
            const expanded = expandedId === row.id;
            return (
              <Fragment key={row.id}>
                <tr
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
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {row.sourceName}{row.sourceStatus ? ` - ${row.sourceStatus}` : ''}{row.sourceDetail ? ` - ${row.sourceDetail}` : ''}
                    </div>
                    {row.subcontract && <span className="mt-1 inline-flex rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary">Terceirizada</span>}
                  </td>
                  <td className="p-2 align-top text-center">{row.unit}</td>
                  <td className={`p-2 align-top text-right tabular-nums font-semibold ${BORDER_L}`}>{fmtQty(row.quantityFinal)}</td>
                  <td className={`p-2 align-top text-right tabular-nums ${BORDER_L}`}>{fmtBRL(row.unitPriceReference)}</td>
                  <td className="p-2 align-top text-right tabular-nums">{fmtBRL(row.unitPriceContracted)}</td>
                  <td className="p-2 align-top text-right tabular-nums font-semibold">{fmtBRL(row.contractedValue)}</td>
                  <td className={`p-2 align-top text-right tabular-nums ${BORDER_L}`}>{fmtBRL(row.materialCost)}</td>
                  <td className="p-2 align-top text-right tabular-nums">{fmtBRL(row.laborCost)}</td>
                  <td className="p-2 align-top text-right tabular-nums text-primary">{fmtBRL(row.contractedLaborCost)}</td>
                  <td className={`p-2 align-top text-right tabular-nums ${BORDER_L}`}>{row.isCertified ? fmtBRL(row.committedCost) : '—'}</td>
                  <td className="p-2 align-top text-right tabular-nums font-semibold">{fmtBRL(row.realCost)}</td>
                  <td
                    className={`p-2 align-top text-right tabular-nums font-semibold ${row.signal === 'incomplete' ? 'text-warning' : row.grossProfit >= 0 ? 'text-success' : 'text-destructive'}`}
                  >
                    {row.isCertified ? fmtBRL(row.grossProfit) : '—'}
                  </td>
                  <td
                    className={`p-2 align-top text-right tabular-nums font-semibold ${row.signal === 'incomplete' ? 'text-warning' : marginTone(row.marginPct)}`}
                  >
                    {row.isCertified ? fmtPct(row.marginPct) : '—'}
                  </td>
                  <td className="p-2 align-top text-center">{pendingCount(row)}</td>
                  <td className="p-2 align-top text-center"><SignalBadge signal={row.signal} /></td>
                </tr>
                {expanded && <RealCostCompositionDetail row={row} />}
              </Fragment>
            );
          })}
          {group.children.map(child => (
            <RealCostGroupRows
              key={child.phaseId}
              group={child}
              collapsed={collapsed}
              toggleCollapsed={toggleCollapsed}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
            />
          ))}
        </Fragment>
      )}

    </Fragment>
  );
}

function uid(prefix: string) { return `${prefix}_${crypto.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`; }
function today() { return new Date().toISOString().slice(0, 10); }

function Checkbox({ checked, indeterminate = false, disabled = false, onChange, label }: {
  checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: () => void; label: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      ref={node => { if (node) node.indeterminate = indeterminate; }}
      onChange={onChange}
      className="h-4 w-4 shrink-0 accent-primary disabled:cursor-not-allowed"
    />
  );
}

export function SubcontractsTab({ project, analysis, canManage, canDeleteHistory = false, auditActor, onProjectChange }: {
  project: Project; analysis: ReturnType<typeof buildRealCostAnalysis>; canManage: boolean; canDeleteHistory?: boolean; auditActor?: AuditUserInfo; onProjectChange: (project: Project) => void;
}) {
  const [name, setName] = useState('');
  const [contractor, setContractor] = useState('');
  const [value, setValue] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingContractId, setEditingContractId] = useState<string | null>(null);
  const [amendmentReason, setAmendmentReason] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedContracts, setExpandedContracts] = useState<Set<string>>(new Set());
  const [expandedAmendmentHistory, setExpandedAmendmentHistory] = useState<Set<string>>(new Set());
  const [activityFilter, setActivityFilter] = useState<'all' | 'selected' | 'with-production' | 'without-task'>('all');
  const [paymentFor, setPaymentFor] = useState<string | null>(null);
  const [paymentValue, setPaymentValue] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [simulationDrafts, setSimulationDrafts] = useState<Record<string, string>>({});
  const editingContract = (project.subcontracts ?? []).find(contract => contract.id === editingContractId);
  const compositionById = useMemo(() => new Map(analysis.compositions.map(row => [row.id, row])), [analysis.compositions]);
  const blockedBy = useMemo(() => new Map(
    (project.subcontracts ?? [])
      .filter(contract => contract.status !== 'cancelled' && contract.id !== editingContractId)
      .flatMap(contract => contract.items.map(item => [item.compositionId, contract.name] as const)),
  ), [project.subcontracts, editingContractId]);
  const executionForAllocation = (allocation: Subcontract['items'][number], quantity: number) => {
    // O taskId salvo é histórico; a hierarquia atual da composição é a fonte
    // de verdade e impede que código/descrição repetidos misturem produções.
    const taskId = compositionById.get(allocation.compositionId)?.taskId;
    return taskId
      ? Math.min(Math.max(0, quantity), subcontractExecutedQuantity(project, allocation.id, taskId))
      : 0;
  };
  const executionForRow = (row: RealCostCompositionRow) => {
    const allocation = editingContract?.items.find(item => item.compositionId === row.id);
    const quantity = allocation?.contractedQuantity ?? row.quantityFinal;
    return allocation && quantity > 0 && row.taskId
      ? Math.min(quantity, subcontractExecutedQuantity(project, allocation.id, row.taskId))
      : 0;
  };
  const selectableRows = useMemo(
    () => analysis.compositions.filter(row => row.laborCost > 0 && !blockedBy.has(row.id)),
    [analysis.compositions, blockedBy],
  );
  const selectableIds = useMemo(() => new Set(selectableRows.map(row => row.id)), [selectableRows]);
  const selectedRows = analysis.compositions.filter(row => selected.includes(row.id));
  const preview = allocateSubcontractValue(Number(value.replace(',', '.')) || 0, selectedRows.map(row => ({ compositionId: row.id, referenceLaborCost: row.laborCost })));
  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (row: RealCostCompositionRow) => !normalizedQuery || `${row.item} ${row.code ?? ''} ${row.bank ?? ''} ${row.description} ${row.chapter}`.toLowerCase().includes(normalizedQuery);
  const setRowsSelected = (rows: RealCostCompositionRow[]) => {
    const ids = [...new Set(rows.map(row => row.id).filter(id => selectableIds.has(id)))];
    if (ids.length === 0) return;
    setSelected(current => {
      if (ids.every(id => current.includes(id))) return current.filter(id => !ids.includes(id));
      return [...new Set([...current, ...ids])];
    });
  };
  const groupRows = (group: RealCostGroupNode): RealCostCompositionRow[] => [
    ...group.rows,
    ...group.children.flatMap(groupRows),
  ];
  const toggleCollapsed = (id: string) => setCollapsedGroups(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleContractItems = (contractId: string) => setExpandedContracts(current => {
    const next = new Set(current);
    if (next.has(contractId)) next.delete(contractId);
    else next.add(contractId);
    return next;
  });
  const toggleAmendmentHistory = (contractId: string) => setExpandedAmendmentHistory(current => {
    const next = new Set(current);
    if (next.has(contractId)) next.delete(contractId);
    else next.add(contractId);
    return next;
  });
  const persist = (next: Project, action: 'created' | 'contracted' | 'updated' | 'deleted', contract: Subcontract, title: string) => onProjectChange(logToProject(next, { ...auditActor, entityType: 'subcontract', entityId: contract.id, action, title, description: contract.name }));
  const buildAllocations = (existing?: Subcontract) => {
    const existingByCompositionId = new Map(existing?.items.map(item => [item.compositionId, item]) ?? []);
    return preview.map((allocation, index) => {
      const row = selectedRows[index];
      const previous = existingByCompositionId.get(row.id);
      return {
        id: previous?.id ?? uid('subitem'), compositionId: row.id,
        budgetItemId: row.id.startsWith('budget:') ? row.id.slice(7) : undefined,
        additiveCompositionId: row.id.startsWith('additive:') ? row.id.split(':').at(-1) : undefined,
        analyticCompositionId: row.id.startsWith('analytic:') ? row.id.slice(9) : undefined,
        item: row.item, code: row.code, bank: row.bank, description: row.description, unit: row.unit,
        referenceLaborCost: row.laborCost, allocationPercent: allocation.allocationPercent,
        contractedAmount: allocation.allocatedAmount, taskId: row.taskId,
        contractedQuantity: row.quantityFinal > 0 ? row.quantityFinal : undefined,
        simulatedExecutedQuantity: previous?.simulatedExecutedQuantity,
      };
    });
  };
  const create = (status: Subcontract['status']) => {
    const total = Number(value.replace(',', '.')) || 0;
    if (!name.trim() || !contractor.trim() || total <= 0 || selectedRows.length === 0) return;
    const id = uid('subcontract'); const now = new Date().toISOString();
    const contract: Subcontract = { id, name: name.trim(), contractorName: contractor.trim(), contractDate: today(), contractedValue: total, status, payments: [], createdAt: now, createdBy: auditActor?.userId, contractedAt: status === 'contracted' ? now : undefined, contractedBy: status === 'contracted' ? auditActor?.userId : undefined, items: buildAllocations() };
    persist({ ...project, subcontracts: [...(project.subcontracts ?? []), contract] }, status === 'contracted' ? 'contracted' : 'created', contract, status === 'contracted' ? 'Contrato terceirizado formalizado' : 'Rascunho de terceirização criado');
    setShowForm(false); setName(''); setContractor(''); setValue(''); setSelected([]);
  };
  const beginAmendment = (contract: Subcontract) => {
    setEditingContractId(contract.id); setShowForm(false); setName(contract.name); setContractor(contract.contractorName);
    setValue(String(contract.contractedValue)); setSelected(contract.items.map(item => item.compositionId)); setAmendmentReason(''); setActivityFilter('all');
  };
  const applyAmendment = (contract: Subcontract) => {
    const total = Number(value.replace(',', '.')) || 0;
    const paid = subcontractPaidValue(contract);
    if (!amendmentReason.trim() || total < paid || selectedRows.length === 0 || total <= 0) return;
    const removedWithProduction = contract.items.filter(item => !selected.includes(item.compositionId) && executionForAllocation(item, item.contractedQuantity ?? compositionById.get(item.compositionId)?.quantityFinal ?? 0) > 0);
    if (removedWithProduction.length > 0 && !window.confirm(`Há produção já apontada em ${removedWithProduction.map(item => item.item).join(', ')}. Remover estes itens não apagará o histórico de produção nem pagamentos já lançados. Confirmar alteração do escopo?`)) return;
    const now = new Date().toISOString(); const nextItems = buildAllocations(contract);
    const next: Subcontract = {
      ...contract, name: name.trim(), contractorName: contractor.trim(), contractedValue: total, items: nextItems,
      payments: freezeSubcontractPayments(contract),
      amendments: [...(contract.amendments ?? []), { id: uid('subcontract-amendment'), date: today(), reason: amendmentReason.trim(), previousContractedValue: contract.contractedValue, nextContractedValue: total, previousItems: contract.items, nextItems, createdAt: now, createdBy: auditActor?.userId }],
      updatedAt: now, updatedBy: auditActor?.userId,
    };
    updateContract(contract, next, 'updated', `Atividades e rateio atualizados: ${amendmentReason.trim()}`);
    setShowForm(false); setEditingContractId(null); setAmendmentReason(''); setName(''); setContractor(''); setValue(''); setSelected([]);
  };
  const updateContract = (contract: Subcontract, next: Subcontract, action: 'updated' | 'deleted' | 'contracted', title: string) => persist({ ...project, subcontracts: (project.subcontracts ?? []).map(c => c.id === contract.id ? next : c) }, action, next, title);
  const simulationQuantity = (allocation: Subcontract['items'][number], maximum: number) => {
    const draft = simulationDrafts[allocation.id];
    const quantity = draft === undefined ? allocation.simulatedExecutedQuantity ?? 0 : Number(draft);
    return Math.min(Math.max(0, Number.isFinite(quantity) ? quantity : 0), maximum);
  };
  const updateSimulation = (contract: Subcontract, allocation: Subcontract['items'][number], maximum: number) => {
    const simulatedExecutedQuantity = simulationQuantity(allocation, maximum);
    setSimulationDrafts(current => {
      const next = { ...current };
      delete next[allocation.id];
      return next;
    });
    if (simulatedExecutedQuantity === (allocation.simulatedExecutedQuantity ?? 0)) return;
    const next = {
      ...contract,
      items: contract.items.map(item => item.id === allocation.id ? { ...item, simulatedExecutedQuantity } : item),
      updatedAt: new Date().toISOString(),
      updatedBy: auditActor?.userId,
    };
    updateContract(contract, next, 'updated', 'Simulação de produção terceirizada atualizada');
  };
  const matchesActivityFilter = (row: RealCostCompositionRow) =>
    activityFilter === 'all' ||
    (activityFilter === 'selected' && selected.includes(row.id)) ||
    (activityFilter === 'with-production' && executionForRow(row) > 0) ||
    (activityFilter === 'without-task' && !row.taskId);
  const renderGroup = (group: RealCostGroupNode) => {
    const descendants = groupRows(group).filter(row => row.laborCost > 0);
    const eligible = descendants.filter(row => selectableIds.has(row.id));
    const displayedRows = group.rows.filter(row => row.laborCost > 0 && matchesActivityFilter(row) && (matchesQuery(row) || selected.includes(row.id)));
    const visibleChildren = group.children.filter(child => groupRows(child).some(row => row.laborCost > 0 && matchesActivityFilter(row) && (matchesQuery(row) || selected.includes(row.id))));
    if (displayedRows.length === 0 && visibleChildren.length === 0) return null;
    const selectedCount = eligible.filter(row => selected.includes(row.id)).length;
    const collapsed = collapsedGroups.has(group.phaseId);
    return <div key={group.phaseId} className="border-b last:border-b-0">
      <div className="flex items-center gap-2 bg-muted/40 px-3 py-2" style={{ paddingLeft: `${12 + group.depth * 12}px` }}>
        <button type="button" aria-label={`${collapsed ? 'Expandir' : 'Recolher'} ${group.number}`} onClick={() => toggleCollapsed(group.phaseId)} className="rounded p-1 hover:bg-muted">
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <Checkbox checked={eligible.length > 0 && selectedCount === eligible.length} indeterminate={selectedCount > 0 && selectedCount < eligible.length} disabled={eligible.length === 0} onChange={() => setRowsSelected(eligible)} label={`Selecionar ${group.number} ${group.name}`} />
        <button type="button" onClick={() => toggleCollapsed(group.phaseId)} className="min-w-0 flex-1 text-left text-xs">
          <span className="font-mono font-semibold">{group.number}</span><span className="ml-1 font-semibold uppercase">{group.name}</span>
          <span className="ml-2 text-[10px] text-muted-foreground">{eligible.length} elegível(is) · {fmtBRL(eligible.reduce((sum, row) => sum + row.laborCost, 0))} M.O. ref.</span>
        </button>
      </div>
      {!collapsed && <>
        {displayedRows.map(row => {
          const blockedName = blockedBy.get(row.id);
          const isSelected = selected.includes(row.id);
          return <label key={row.id} className="flex cursor-pointer items-start gap-2 border-t px-3 py-2 text-xs hover:bg-muted/30" style={{ paddingLeft: `${44 + group.depth * 12}px` }}>
            <Checkbox checked={isSelected} disabled={Boolean(blockedName)} onChange={() => setRowsSelected([row])} label={`Selecionar item ${row.item}`} />
            <span className="min-w-0 flex-1"><span className="font-mono font-semibold">{row.item}</span><span className="ml-2">{row.description}</span>{blockedName && <span className="mt-1 block text-[10px] text-muted-foreground">Composição já vinculada ao pacote: {blockedName}</span>}{!blockedName && !row.taskId && <span className="mt-1 block text-[10px] text-warning">Sem tarefa individual com esta hierarquia.</span>}</span>
            <span className="shrink-0 text-right tabular-nums">{fmtBRL(row.laborCost)}</span>
          </label>;
        })}
        {visibleChildren.map(renderGroup)}
      </>}
    </div>;
  };

  const activityFilterControls = editingContract && <div className="flex flex-wrap gap-1" aria-label="Filtros de atividades">
    {([
      ['all', 'Todas'],
      ['selected', 'Já contratadas'],
      ['with-production', 'Com produção'],
      ['without-task', 'Sem tarefa'],
    ] as const).map(([filter, label]) => <Button key={filter} type="button" size="sm" variant={activityFilter === filter ? 'secondary' : 'outline'} onClick={() => setActivityFilter(filter)}>{label}</Button>)}
  </div>;
  return <div className="space-y-3">
    <Card className="p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">Mão de obra terceirizada</h2><p className="text-xs text-muted-foreground">Materiais e Almoxarifado permanecem sob controle da Bueno. Contratos substituem somente o custo comprometido de mão de obra.</p></div>{canManage && <Button size="sm" onClick={() => { setEditingContractId(null); setAmendmentReason(''); setShowForm(v => !v); }}><Plus className="mr-1 h-4 w-4" />Novo pacote</Button>}</div>{!canManage && <p className="mt-2 text-xs text-muted-foreground">Somente Proprietário e Administrador podem cadastrar contratos e pagamentos.</p>}</Card>
    {showForm && <Card className="space-y-3 p-3"><div><h3 className="font-semibold">{editingContract ? 'Alterar atividades e rateio' : 'Novo pacote terceirizado'}</h3><p className="text-xs text-muted-foreground">{editingContract ? 'Pagamentos já lançados permanecem com o rateio histórico. Esta alteração vale apenas para o saldo e para os próximos pagamentos.' : 'Selecione capítulos, subcapítulos ou composições. A seleção de um grupo marca todos os itens elegíveis abaixo dele.'}</p></div><div className="grid gap-2 md:grid-cols-3"><Input aria-label="Nome do serviço ou pacote" placeholder="Nome do serviço/pacote" value={name} disabled={Boolean(editingContract)} onChange={e => setName(e.target.value)} /><Input aria-label="Empresa ou prestador" placeholder="Empresa ou prestador" value={contractor} disabled={Boolean(editingContract)} onChange={e => setContractor(e.target.value)} /><Input aria-label="Valor contratado" inputMode="decimal" placeholder="Valor contratado (R$)" value={value} onChange={e => setValue(e.target.value)} /></div>{editingContract && <Textarea aria-label="Motivo da alteração do contrato" rows={2} placeholder="Motivo da alteração: inclusão ou exclusão de atividades, revisão do escopo ou do valor" value={amendmentReason} onChange={event => setAmendmentReason(event.target.value)} />}<Input aria-label="Buscar composições" placeholder="Buscar por item, código, capítulo ou descrição" value={query} onChange={e => setQuery(e.target.value)} /><div className="max-h-[26rem] overflow-auto rounded-md border">{analysis.groupTree.map(renderGroup)}</div><div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-xs sm:grid-cols-3"><div><span className="text-muted-foreground">Itens selecionados</span><p className="font-semibold tabular-nums">{selectedRows.length}</p></div><div><span className="text-muted-foreground">M.O. ref. SINAPI</span><p className="font-semibold tabular-nums">{fmtBRL(selectedRows.reduce((sum, row) => sum + row.laborCost, 0))}</p></div><div><span className="text-muted-foreground">Valor para rateio</span><p className="font-semibold tabular-nums">{fmtBRL(Number(value.replace(',', '.')) || 0)}</p></div></div>{preview.length > 0 && <p className="text-xs text-muted-foreground">Prévia do rateio: {preview.map((item, index) => `${selectedRows[index].item} ${fmtBRL(item.allocatedAmount)}`).join(' · ')}</p>}{editingContract && subcontractPaidValue(editingContract) > 0 && <p className="text-xs text-muted-foreground">Já pago: {fmtBRL(subcontractPaidValue(editingContract))}. O novo valor contratado não pode ser menor que esse total.</p>}<div className="flex flex-wrap gap-2">{editingContract ? <><Button variant="outline" onClick={() => { setShowForm(false); setEditingContractId(null); setAmendmentReason(''); }}>Cancelar alteração</Button><Button disabled={!amendmentReason.trim() || selectedRows.length === 0 || Number(value.replace(',', '.')) < subcontractPaidValue(editingContract)} onClick={() => applyAmendment(editingContract)}>Aplicar alteração</Button></> : <><Button variant="outline" onClick={() => create('draft')}>Salvar rascunho</Button><Button onClick={() => create('contracted')}>Confirmar contratação</Button></>}</div></Card>}
    {(project.subcontracts ?? []).map(contract => {
      const itemsExpanded = expandedContracts.has(contract.id);
      const paid = subcontractPaidValue(contract);
      const balance = subcontractBalance(contract);
      const sinapiLaborTotal = roundMoney(contract.items.reduce(
        (sum, allocation) => sum + (compositionById.get(allocation.compositionId)?.laborCost ?? allocation.referenceLaborCost),
        0,
      ));
      const contractSavings = roundMoney(sinapiLaborTotal - contract.contractedValue);
      const producedValue = roundMoney(contract.items.reduce((sum, allocation) => {
        const row = compositionById.get(allocation.compositionId);
        const quantity = allocation.contractedQuantity ?? row?.quantityFinal ?? 0;
        const taskId = row?.taskId;
        const executed = taskId
          ? Math.min(Math.max(0, quantity), subcontractExecutedQuantity(project, allocation.id, taskId))
          : 0;
        return sum + (quantity > 0 ? allocation.contractedAmount * executed / quantity : 0);
      }, 0));
      const simulatedValue = roundMoney(contract.items.reduce((sum, allocation) => {
        const row = compositionById.get(allocation.compositionId);
        const quantity = allocation.contractedQuantity ?? row?.quantityFinal ?? 0;
        const simulated = simulationQuantity(allocation, quantity);
        return sum + (quantity > 0 ? allocation.contractedAmount * simulated / quantity : 0);
      }, 0));
      const payableByProduction = roundMoney(Math.max(0, Math.min(balance, producedValue - paid)));
      return <Card key={contract.id} className="overflow-hidden">
        <div className="cursor-pointer border-b bg-muted/30 p-3 transition-colors hover:bg-muted/50" role="button" tabIndex={0} aria-label={`Alternar itens contratados do pacote ${contract.name}`} aria-expanded={itemsExpanded} aria-controls={`subcontract-items-${contract.id}`} onClick={event => { if (!(event.target as HTMLElement).closest('button, input, select, textarea, a')) toggleContractItems(contract.id); }} onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleContractItems(contract.id); } }}>
          <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h3 className="font-semibold">{contract.name}<span className="mx-2 text-muted-foreground" aria-hidden="true">·</span><span className="font-medium text-muted-foreground">{contract.contractorName}</span></h3><p className="text-xs text-muted-foreground">{contract.items.length} composição(ões) contratada(s)</p></div><span className="rounded-full border bg-background px-2 py-0.5 text-[10px]">{contract.status === 'contracted' ? 'Contratado' : contract.status === 'cancelled' ? 'Cancelado' : 'Rascunho'}</span></div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-9"><div>M.O. SINAPI<br/><b className="tabular-nums">{fmtBRL(sinapiLaborTotal)}</b></div><div>Contratado<br/><b className="tabular-nums">{fmtBRL(contract.contractedValue)}</b></div><div>Economia<br/><b className={`tabular-nums ${contractSavings >= 0 ? 'text-success' : 'text-destructive'}`}>{contractSavings >= 0 ? '' : '-'}{fmtBRL(Math.abs(contractSavings))}</b></div><div>Itens com produção<br/><b className="tabular-nums text-primary">{contract.items.filter(allocation => executionForAllocation(allocation, allocation.contractedQuantity ?? compositionById.get(allocation.compositionId)?.quantityFinal ?? 0) > 0).length}/{contract.items.length}</b><span className="ml-1 text-[10px] text-muted-foreground">executados</span></div><div>Produzido<br/><b className="tabular-nums text-primary">{fmtBRL(producedValue)}</b></div><div>Simulado<br/><b className="tabular-nums text-violet-700">{fmtBRL(simulatedValue)}</b></div><div>Disponível p/ pagar<br/><b className="tabular-nums text-primary">{fmtBRL(payableByProduction)}</b></div><div>Pago<br/><b className="tabular-nums">{fmtBRL(paid)}</b></div><div>Saldo<br/><b className="tabular-nums">{fmtBRL(balance)}</b></div></div>
          {canManage && contract.status === 'draft' && <Button size="sm" className="mt-3" onClick={() => updateContract(contract, { ...contract, status: 'contracted', contractedAt: new Date().toISOString(), contractedBy: auditActor?.userId, updatedAt: new Date().toISOString() }, 'contracted', 'Contrato terceirizado formalizado')}>Confirmar contratação</Button>}
          {canManage && contract.status === 'contracted' && <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { setPaymentFor(paymentFor === contract.id ? null : contract.id); setPaymentNotes(''); }}><ReceiptText className="mr-1 h-3 w-3" />Lançar pagamento</Button><Button size="sm" variant="outline" onClick={() => beginAmendment(contract)}>Alterar atividades</Button><Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt('Motivo do cancelamento:'); if (reason) updateContract(contract, { ...contract, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: auditActor?.userId, cancellationReason: reason, updatedAt: new Date().toISOString() }, 'deleted', 'Contrato terceirizado cancelado'); }}>Cancelar</Button></div>}
          {(contract.amendments?.length ?? 0) > 0 && <div className="mt-3"><Button size="sm" variant="ghost" onClick={event => { event.stopPropagation(); toggleAmendmentHistory(contract.id); }} aria-expanded={expandedAmendmentHistory.has(contract.id)}><History className="mr-1 h-3 w-3" />Histórico de alterações ({contract.amendments?.length})</Button>{expandedAmendmentHistory.has(contract.id) && <div className="mt-2 space-y-2 rounded-md border bg-background/70 p-2 text-xs">{[...(contract.amendments ?? [])].reverse().map(amendment => <div key={amendment.id} className="flex items-start justify-between gap-3 border-b pb-2 last:border-b-0 last:pb-0"><div><p className="font-medium">{amendment.date} · {amendment.reason}</p><p className="text-muted-foreground">Itens: {amendment.previousItems.length} → {amendment.nextItems.length} · Contratado: {fmtBRL(amendment.previousContractedValue)} → {fmtBRL(amendment.nextContractedValue)}</p></div>{canDeleteHistory && <Button size="sm" variant="ghost" className="shrink-0 text-destructive hover:text-destructive" aria-label={`Excluir registro do histórico: ${amendment.reason}`} onClick={event => { event.stopPropagation(); if (window.confirm(`Excluir do histórico a alteração “${amendment.reason}”? Esta ação não desfaz o contrato atual nem pagamentos já lançados.`)) updateContract(contract, { ...contract, amendments: contract.amendments?.filter(entry => entry.id !== amendment.id), updatedAt: new Date().toISOString(), updatedBy: auditActor?.userId }, 'updated', `Registro de histórico removido pelo Proprietário: ${amendment.reason}`); }}>Excluir</Button>}</div>)}</div>}</div>}
          {paymentFor === contract.id && <div className="mt-2 space-y-2 rounded-md border bg-background/70 p-2"><div className="flex flex-col gap-2 sm:flex-row"><Input inputMode="decimal" aria-label="Valor do pagamento" placeholder={`Valor pago (máx. ${fmtBRL(payableByProduction)})`} value={paymentValue} onChange={e => setPaymentValue(e.target.value)} /><Button size="sm" disabled={payableByProduction <= 0} onClick={() => { const amount = Number(paymentValue.replace(',', '.')) || 0; if (amount <= 0 || amount > payableByProduction) return; const next = { ...contract, payments: [...contract.payments, { id: uid('payment'), date: today(), amount, notes: paymentNotes.trim() || undefined, allocations: allocateSubcontractValue(amount, contract.items).map(item => ({ allocationId: item.id, amount: item.allocatedAmount })), createdAt: new Date().toISOString(), createdBy: auditActor?.userId }], updatedAt: new Date().toISOString(), updatedBy: auditActor?.userId }; updateContract(contract, next, 'updated', 'Pagamento de terceirizada lançado'); setPaymentValue(''); setPaymentNotes(''); setPaymentFor(null); }}>Confirmar</Button></div><Textarea aria-label="Observação do pagamento" rows={2} placeholder="Observação do pagamento: descreva o serviço ou a etapa quitada" value={paymentNotes} onChange={event => setPaymentNotes(event.target.value)} /></div>}
          <div className="mt-2 space-y-1 text-[11px]">{contract.payments.map(payment => <div key={payment.id} className="flex items-start justify-between gap-2 rounded bg-background/70 px-2 py-1"><span>{payment.date} · {fmtBRL(payment.amount)}{payment.reversedAt ? ' · estornado' : ''}{payment.notes && <span className="block text-muted-foreground">{payment.notes}</span>}</span>{canManage && !payment.reversedAt && <button type="button" className="shrink-0 text-primary hover:underline" onClick={() => { const reason = window.prompt('Motivo do estorno:'); if (reason) updateContract(contract, { ...contract, payments: contract.payments.map(p => p.id === payment.id ? { ...p, reversedAt: new Date().toISOString(), reversedBy: auditActor?.userId, reversalReason: reason } : p), updatedAt: new Date().toISOString() }, 'updated', 'Pagamento de terceirizada estornado'); }}><Undo2 className="inline h-3 w-3" /> Estornar</button>}</div>)}</div>
        </div>
          {editingContractId === contract.id && <div className="space-y-3 border-b bg-muted/10 p-3"><div><h4 className="font-semibold">Alterar atividades e rateio</h4><p className="text-xs text-muted-foreground">Este ajuste pertence ao pacote {contract.name}. Os pagamentos já lançados conservam o rateio histórico.</p></div><div className="grid gap-2 md:grid-cols-3"><Input aria-label="Nome do serviço ou pacote" value={name} disabled /><Input aria-label="Empresa ou prestador" value={contractor} disabled /><Input aria-label="Valor contratado" inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} /></div><Textarea aria-label="Motivo da alteração do contrato" rows={2} placeholder="Motivo da alteração: inclusão ou exclusão de atividades, revisão do escopo ou do valor" value={amendmentReason} onChange={event => setAmendmentReason(event.target.value)} />{activityFilterControls}<Input aria-label="Buscar composições" placeholder="Buscar por item, código, capítulo ou descrição" value={query} onChange={e => setQuery(e.target.value)} /><div className="max-h-[26rem] overflow-auto rounded-md border bg-background">{analysis.groupTree.map(renderGroup)}</div><div className="grid gap-2 rounded-md border bg-background/70 p-3 text-xs sm:grid-cols-3"><div><span className="text-muted-foreground">Itens selecionados</span><p className="font-semibold tabular-nums">{selectedRows.length}</p></div><div><span className="text-muted-foreground">M.O. ref. SINAPI</span><p className="font-semibold tabular-nums">{fmtBRL(selectedRows.reduce((sum, row) => sum + row.laborCost, 0))}</p></div><div><span className="text-muted-foreground">Valor para rateio</span><p className="font-semibold tabular-nums">{fmtBRL(Number(value.replace(',', '.')) || 0)}</p></div></div>{preview.length > 0 && <p className="text-xs text-muted-foreground">Prévia do rateio: {preview.map((item, index) => `${selectedRows[index].item} ${fmtBRL(item.allocatedAmount)}`).join(' · ')}</p>}{paid > 0 && <p className="text-xs text-muted-foreground">Já pago: {fmtBRL(paid)}. O novo valor contratado não pode ser menor que esse total.</p>}<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { setEditingContractId(null); setAmendmentReason(''); }}>Cancelar alteração</Button><Button disabled={!amendmentReason.trim() || selectedRows.length === 0 || Number(value.replace(',', '.')) < paid} onClick={() => applyAmendment(contract)}>Aplicar alteração</Button></div></div>}
        {itemsExpanded && <div id={`subcontract-items-${contract.id}`}>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1220px] text-xs">
            <thead>
              <tr className="border-b bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="p-2 text-left" rowSpan={2}>Item</th><th className="p-2 text-left" rowSpan={2}>Serviço</th><th className="p-2 text-center" rowSpan={2}>Un.</th><th className="p-2 text-right" rowSpan={2}>Quantidade</th>
                <th className="bg-sky-100/70 p-2 text-center text-sky-900 dark:bg-sky-950/40 dark:text-sky-100" colSpan={2}>Referência SINAPI</th>
                <th className="bg-muted/70 p-2 text-center" colSpan={2}>Execução</th>
                <th className="bg-violet-100/70 p-2 text-center text-violet-900 dark:bg-violet-950/40 dark:text-violet-100" colSpan={2}>Simulação</th>
                <th className="bg-emerald-100/70 p-2 text-center text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100" colSpan={2}>Contrato terceirizado</th>
              </tr>
              <tr className="border-b bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="bg-sky-50/80 p-2 text-right dark:bg-sky-950/20">M.O. unit.</th><th className="bg-sky-50/80 p-2 text-right dark:bg-sky-950/20">M.O. total</th>
                <th className="bg-muted/40 p-2 text-right">Executado</th><th className="bg-muted/40 p-2 text-right">Produzido</th>
                <th className="bg-violet-50/80 p-2 text-right dark:bg-violet-950/20">Quantidade prevista</th><th className="bg-violet-50/80 p-2 text-right dark:bg-violet-950/20">Valor projetado</th>
                <th className="bg-emerald-50/80 p-2 text-right dark:bg-emerald-950/20">Unitário</th><th className="bg-emerald-50/80 p-2 text-right dark:bg-emerald-950/20">Total</th>
              </tr>
            </thead>
            <tbody>{contract.items.map(allocation => {
              const row = compositionById.get(allocation.compositionId); const reference = row?.laborCost ?? allocation.referenceLaborCost; const quantity = allocation.contractedQuantity ?? row?.quantityFinal; const hasQuantity = Number.isFinite(quantity) && (quantity ?? 0) > 0; const taskId = row?.taskId; const executed = hasQuantity && taskId ? Math.min(quantity ?? 0, subcontractExecutedQuantity(project, allocation.id, taskId)) : 0; const laborUnit = hasQuantity ? reference / (quantity ?? 1) : null; const contractUnit = hasQuantity ? allocation.contractedAmount / (quantity ?? 1) : null; const produced = contractUnit === null ? 0 : roundMoney(executed * contractUnit); const simulated = hasQuantity ? simulationQuantity(allocation, quantity ?? 0) : 0; const simulatedProduced = contractUnit === null ? 0 : roundMoney(simulated * contractUnit); const simulationDraft = simulationDrafts[allocation.id] ?? (allocation.simulatedExecutedQuantity == null ? '' : String(allocation.simulatedExecutedQuantity));
              return <tr key={allocation.id} className="border-t"><td className="p-2 align-top font-mono">{allocation.item}<br/><span className="text-muted-foreground">{allocation.code || '-'}</span></td><td className="p-2 align-top">{allocation.description}{!hasQuantity && <p className="mt-1 text-[10px] text-warning">Sem base física para pagamento unitário.</p>}{!taskId && <p className="mt-1 text-[10px] text-warning">Sem tarefa individual com esta hierarquia para produção automática.</p>}{row?.subcontract?.reconciliationIssue && <p className="mt-1 text-[10px] text-warning">Revisar vínculo/Analítica</p>}</td><td className="p-2 text-center">{row?.unit || allocation.unit}</td><td className="p-2 text-right tabular-nums">{hasQuantity ? fmtQty(quantity ?? 0) : '—'}</td><td className="bg-sky-50/50 p-2 text-right tabular-nums dark:bg-sky-950/10">{laborUnit === null ? '—' : fmtBRL(laborUnit)}</td><td className="bg-sky-50/50 p-2 text-right tabular-nums dark:bg-sky-950/10">{fmtBRL(reference)}</td><td className="bg-muted/25 p-2 text-right tabular-nums">{hasQuantity ? fmtQty(executed) : '—'}</td><td className="bg-muted/25 p-2 text-right tabular-nums text-primary">{fmtBRL(produced)}</td><td className="bg-violet-50/50 p-1 dark:bg-violet-950/10">{hasQuantity ? <Input className="ml-auto min-h-11 w-28 text-right text-base tabular-nums" aria-label={`Simulação de ${allocation.description}`} type="number" min="0" max={quantity ?? 0} step="any" inputMode="decimal" disabled={!canManage || contract.status !== 'contracted'} value={simulationDraft} onClick={event => event.stopPropagation()} onChange={event => setSimulationDrafts(current => ({ ...current, [allocation.id]: event.target.value }))} onBlur={() => updateSimulation(contract, allocation, quantity ?? 0)} /> : '—'}</td><td className="bg-violet-50/50 p-2 text-right tabular-nums text-violet-700 dark:bg-violet-950/10">{fmtBRL(simulatedProduced)}</td><td className="bg-emerald-50/50 p-2 text-right tabular-nums dark:bg-emerald-950/10">{contractUnit === null ? '—' : fmtBRL(contractUnit)}</td><td className="bg-emerald-50/50 p-2 text-right font-semibold tabular-nums dark:bg-emerald-950/10">{fmtBRL(allocation.contractedAmount)}</td></tr>;
            })}</tbody>
          </table>
        </div>
        <div className="space-y-2 p-3 md:hidden">{contract.items.map(allocation => {
          const row = compositionById.get(allocation.compositionId); const reference = row?.laborCost ?? allocation.referenceLaborCost; const quantity = allocation.contractedQuantity ?? row?.quantityFinal; const hasQuantity = Number.isFinite(quantity) && (quantity ?? 0) > 0; const taskId = row?.taskId; const executed = hasQuantity ? executionForAllocation(allocation, quantity ?? 0) : 0; const laborUnit = hasQuantity ? reference / (quantity ?? 1) : null; const contractUnit = hasQuantity ? allocation.contractedAmount / (quantity ?? 1) : null; const produced = contractUnit === null ? 0 : roundMoney(executed * contractUnit); const simulated = hasQuantity ? simulationQuantity(allocation, quantity ?? 0) : 0; const simulatedProduced = contractUnit === null ? 0 : roundMoney(simulated * contractUnit); const simulationDraft = simulationDrafts[allocation.id] ?? (allocation.simulatedExecutedQuantity == null ? '' : String(allocation.simulatedExecutedQuantity));
          return <div key={allocation.id} className="rounded-md border p-3 text-xs"><p className="font-mono font-semibold">{allocation.item}</p><p className="mt-1 font-medium leading-snug">{allocation.description}</p>{!hasQuantity && <p className="mt-1 text-[10px] text-warning">Sem base física para pagamento unitário.</p>}{!taskId && <p className="mt-1 text-[10px] text-warning">Sem tarefa individual com esta hierarquia para produção automática.</p>}<div className="mt-3 grid grid-cols-2 gap-2"><span>Un. <b className="float-right">{row?.unit || allocation.unit}</b></span><span>Quantidade <b className="float-right tabular-nums">{hasQuantity ? fmtQty(quantity ?? 0) : '—'}</b></span><span className="rounded bg-sky-50 p-2 dark:bg-sky-950/20">M.O. unit. SINAPI <b className="float-right tabular-nums">{laborUnit === null ? '—' : fmtBRL(laborUnit)}</b></span><span className="rounded bg-sky-50 p-2 dark:bg-sky-950/20">M.O. total SINAPI <b className="float-right tabular-nums">{fmtBRL(reference)}</b></span><span className="rounded bg-muted/50 p-2">Executado <b className="float-right tabular-nums">{hasQuantity ? fmtQty(executed) : '—'}</b></span><span className="rounded bg-muted/50 p-2">Produzido <b className="float-right tabular-nums text-primary">{fmtBRL(produced)}</b></span><label className="rounded bg-violet-50 p-2 dark:bg-violet-950/20">Simulação ({row?.unit || allocation.unit}){hasQuantity ? <Input className="mt-1 min-h-11 text-base tabular-nums" aria-label={`Simulação de ${allocation.description}`} type="number" min="0" max={quantity ?? 0} step="any" inputMode="decimal" disabled={!canManage || contract.status !== 'contracted'} value={simulationDraft} onChange={event => setSimulationDrafts(current => ({ ...current, [allocation.id]: event.target.value }))} onBlur={() => updateSimulation(contract, allocation, quantity ?? 0)} /> : <b className="float-right">—</b>}</label><span className="rounded bg-violet-50 p-2 dark:bg-violet-950/20">Valor projetado <b className="float-right tabular-nums text-violet-700">{fmtBRL(simulatedProduced)}</b></span><span className="rounded bg-emerald-50 p-2 dark:bg-emerald-950/20">Contrato unit. <b className="float-right tabular-nums">{contractUnit === null ? '—' : fmtBRL(contractUnit)}</b></span><span className="rounded bg-emerald-50 p-2 dark:bg-emerald-950/20">Contrato total <b className="float-right tabular-nums">{fmtBRL(allocation.contractedAmount)}</b></span></div></div>;
        })}</div>
        </div>}
      </Card>;
    })}
  </div>;
}

export default function RealCost({ project, onProjectChange, canManageSubcontracts, canDeleteSubcontractHistory = false, auditActor }: Props) {
  const trabalhaSabado = useMemo(() => loadObraConfig().trabalhaSabado, []);
  const analysis = useMemo(() => buildRealCostAnalysis(project, trabalhaSabado), [project, trabalhaSabado]);
  const uiStorageKey = `obraPlanner:realCost:ui:${project.id || project.name || 'default'}`;
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'general' | 'subcontracts'>('general');
  const [statusFilter, setStatusFilter] = useState<'all' | RealCostSignal>('all');
  const [chapterFilter, setChapterFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = JSON.parse(window.localStorage.getItem(uiStorageKey) || '{}') as { expandedId?: string };
      return saved.expandedId || null;
    } catch {
      return null;
    }
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const saved = JSON.parse(window.localStorage.getItem(uiStorageKey) || '{}') as { collapsed?: string[] };
      return new Set(Array.isArray(saved.collapsed) ? saved.collapsed : []);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = JSON.parse(window.localStorage.getItem(uiStorageKey) || '{}') as {
        collapsed?: string[];
        expandedId?: string;
      };
      setCollapsed(new Set(Array.isArray(saved.collapsed) ? saved.collapsed : []));
      setExpandedId(saved.expandedId || null);
    } catch {
      setCollapsed(new Set());
      setExpandedId(null);
    }
  }, [uiStorageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(uiStorageKey, JSON.stringify({
      collapsed: Array.from(collapsed),
      expandedId,
    }));
  }, [collapsed, expandedId, uiStorageKey]);

  const filteredGroupTree = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rowMatches = (row: RealCostCompositionRow) => {
      if (statusFilter !== 'all' && row.signal !== statusFilter) return false;
      if (!q) return true;
      const blob = `${row.item} ${row.code ?? ''} ${row.bank ?? ''} ${row.description} ${row.chapter} ${row.sourceName} ${row.sourceStatus ?? ''} ${row.sourceDetail ?? ''}`.toLowerCase();
      return blob.includes(q);
    };

    const filterNode = (node: RealCostGroupNode, ancestorSelected: boolean): RealCostGroupNode | null => {
      const currentSelected = chapterFilter === 'all' || ancestorSelected || node.phaseId === chapterFilter;
      const childAncestorSelected = ancestorSelected || node.phaseId === chapterFilter;
      const rows = currentSelected ? node.rows.filter(rowMatches) : [];
      const children = node.children
        .map(child => filterNode(child, childAncestorSelected))
        .filter((child): child is RealCostGroupNode => child !== null);
      if (rows.length === 0 && children.length === 0) return null;

      return {
        ...node,
        rows,
        children,
        totals: computeVisibleTotals(rows, children),
      };
    };

    return analysis.groupTree
      .map(group => filterNode(group, false))
      .filter((group): group is RealCostGroupNode => group !== null);
  }, [analysis.groupTree, chapterFilter, search, statusFilter]);

  const visibleGroupIds = useMemo(() => collectGroupIds(filteredGroupTree), [filteredGroupTree]);
  const visibleTotals = useMemo(() => computeVisibleTotals([], filteredGroupTree), [filteredGroupTree]);
  const hasActiveFilters = search.trim() !== '' || statusFilter !== 'all' || chapterFilter !== 'all';
  const displayTotals = useMemo<RealCostGroupTotals>(() => {
    if (hasActiveFilters) return visibleTotals;
    const contractedValue = analysis.totals.contractedValue;
    const certifiedContractedValue = visibleTotals.certifiedContractedValue;
    const grossProfit = roundMoney(certifiedContractedValue - visibleTotals.committedCost);
    const marginPct = certifiedContractedValue > 0 ? Math.round((grossProfit / certifiedContractedValue) * 10000) / 100 : 0;
    return {
      ...visibleTotals,
      contractedValue,
      certifiedContractedValue,
      materialCost: visibleTotals.materialCost,
      laborCost: visibleTotals.laborCost,
      grossProfit,
      marginPct,
      signal: analysis.totals.signal,
    };
  }, [analysis.totals, hasActiveFilters, visibleTotals]);

  const toggleCollapsed = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const collapseAll = () => setCollapsed(new Set(visibleGroupIds));
  const expandAll = () => setCollapsed(new Set());

  const visibleCompositionCount = visibleTotals.compositionCount;

  const maxMonthValue = Math.max(1, ...analysis.months.map(month => Math.max(month.certifiedContractedValue, month.committedCost)));
  const costDataComplete = analysis.totals.signal !== 'incomplete';
  const costCoverage = analysis.totals.contractedValue > 0
    ? Math.max(0, Math.round((analysis.totals.certifiedContractedValue / analysis.totals.contractedValue) * 100))
    : 0;

  return (
    <div className="p-3 lg:p-4 space-y-3 max-w-[1900px] mx-auto">
      <header className="rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <CircleDollarSign className="h-5 w-5 text-primary" />
              <h1 className="text-xl font-bold text-foreground">Custo real de obra</h1>
            </div>
            <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
              Compara o contrato com a referência da Analítica e com os valores comprometidos em cotações e compras.
              Não altera Medição, Aditivo, Cronograma, Lista de Material ou Almoxarifado.
            </p>
          </div>
          <SignalBadge signal={analysis.totals.signal} />
        </div>
      </header>

      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        <button type="button" onClick={() => setActiveTab('general')} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${activeTab === 'general' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>Geral</button>
        <button type="button" onClick={() => setActiveTab('subcontracts')} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${activeTab === 'subcontracts' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>Terceirizados</button>
      </div>

      {activeTab === 'subcontracts' ? (
        <SubcontractsTab project={project} analysis={analysis} canManage={canManageSubcontracts} canDeleteHistory={canDeleteSubcontractHistory} auditActor={auditActor} onProjectChange={onProjectChange} />
      ) : <>

      {!costDataComplete && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <p className="font-semibold text-foreground">Cálculo de lucro e margem incompleto</p>
            <p className="mt-0.5 text-muted-foreground">Existem {analysis.pending.inputsWithoutQuote.toLocaleString('pt-BR')} insumos sem cotação e {analysis.pending.incompleteCompositions.toLocaleString('pt-BR')} composições com margem incompleta.</p>
          </div>
        </div>
      )}

      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-2">
        <StatCard
          label="Valor contratado"
          value={fmtBRL(analysis.totals.contractedValue)}
          hint="Receita com BDI"
          icon={CircleDollarSign}
        />
        <StatCard
          label="Cobertura financeira"
          value={`${costCoverage}%`}
          hint={`${fmtBRL(analysis.totals.certifiedContractedValue)} de receita certificada`}
          icon={costDataComplete ? CheckCircle2 : AlertTriangle}
          tone={costDataComplete ? 'success' : 'warning'}
        />
        <StatCard
          label="Custo certificado"
          value={fmtBRL(analysis.totals.committedCost)}
          hint="Menor cotação válida + M.O. SINAPI ou terceirizada"
          icon={BarChart3}
          tone="warning"
        />
        <StatCard
          label="Custo realizado"
          value={fmtBRL(analysis.totals.realCost)}
          hint="Apontamentos e saidas para tarefas"
          icon={BarChart3}
          tone="warning"
        />
        <StatCard
          label="Lucro bruto certificado"
          value={fmtBRL(analysis.totals.grossProfit)}
          hint="Receita certificada - custo certificado"
          icon={analysis.totals.grossProfit >= 0 ? TrendingUp : TrendingDown}
          tone={costDataComplete ? (analysis.totals.grossProfit >= 0 ? 'success' : 'danger') : 'warning'}
        />
        <StatCard
          label="Margem certificada"
          value={fmtPct(analysis.totals.marginPct)}
          hint="Somente composições completas"
          icon={analysis.totals.marginPct >= 15 ? CheckCircle2 : AlertTriangle}
          tone={costDataComplete ? (analysis.totals.marginPct >= 15 ? 'success' : analysis.totals.marginPct >= 5 ? 'warning' : 'danger') : 'warning'}
        />
      </section>

      <Card className="overflow-hidden">
        <div className="border-b border-border bg-muted/30 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Planilha de custo real</h2>
              <p className="text-[11px] text-muted-foreground">
                Capítulos e composições no mesmo quadro. Clique em uma composição para abrir a analítica do custo real.
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
              <option value="healthy">Margem saudável</option>
              <option value="attention">Atenção</option>
              <option value="danger">Crítico</option>
              <option value="incomplete">Incompleto</option>
            </select>
            <button
              type="button"
              onClick={expandAll}
              className="h-8 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-muted"
            >
              Expandir tudo
            </button>
            <button
              type="button"
              onClick={collapseAll}
              className="h-8 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-muted"
            >
              Recolher tudo
            </button>
          </div>
        </div>

        <div className="min-h-[620px] overflow-x-auto overflow-y-visible">
          <table className="w-full min-w-[1720px] border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-20 shadow-sm">
              <tr>
                <th colSpan={5} className="border-b border-border bg-slate-100 px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wider text-slate-800">
                  Identificacao
                </th>
                <th colSpan={1} className={`border-b border-border bg-sky-100 px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wider text-sky-950 ${BORDER_L}`}>
                  Quantidade
                </th>
                <th colSpan={3} className={`border-b border-border bg-blue-100 px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wider text-blue-950 ${BORDER_L}`}>
                  Contrato / referencia
                </th>
                <th colSpan={9} className={`border-b border-border bg-emerald-100 px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wider text-emerald-950 ${BORDER_L}`}>
                  Custo certificado e margem
                </th>
              </tr>
              <tr className="bg-slate-950 text-white">
                <th className="p-2 text-left w-24">Item</th>
                <th className="p-2 text-left w-24">Codigo</th>
                <th className="p-2 text-left w-20">Banco</th>
                <th className="p-2 text-left min-w-[360px]">Descricao</th>
                <th className="p-2 text-center w-16">Un.</th>
                <th className={`p-2 text-right w-24 ${BORDER_L}`}>Qtd.</th>
                <th className={`p-2 text-right w-32 ${BORDER_L}`}>V. Unit. Referencia</th>
                <th className="p-2 text-right w-32">V. Unit. Contratado</th>
                <th className="p-2 text-right w-36">Valor Contratado Final</th>
                <th className={`p-2 text-right w-32 ${BORDER_L}`}>Material ref.</th>
                <th className="p-2 text-right w-32">M.O. SINAPI</th>
                <th className="p-2 text-right w-32">M.O. terceirizada</th>
                <th className={`p-2 text-right w-36 ${BORDER_L}`}>Custo certificado</th>
                <th className="p-2 text-right w-36">Realizado</th>
                <th className="p-2 text-right w-32">Lucro certificado</th>
                <th className="p-2 text-right w-24">Margem cert.</th>
                <th className="p-2 text-center w-20">Pend.</th>
                <th className="p-2 text-center w-28">Semaforo</th>
              </tr>
            </thead>
            <tbody>
              {filteredGroupTree.map(group => (
                <RealCostGroupRows
                  key={group.phaseId}
                  group={group}
                  collapsed={collapsed}
                  toggleCollapsed={toggleCollapsed}
                  expandedId={expandedId}
                  setExpandedId={setExpandedId}
                />
              ))}
              {filteredGroupTree.length === 0 && (
                <tr>
                  <td colSpan={TABLE_COLSPAN} className="p-8 text-center text-sm text-muted-foreground">
                    Nenhuma composição encontrada com os filtros atuais.
                  </td>
                </tr>
              )}
            </tbody>
            {filteredGroupTree.length > 0 && (
              <tfoot className="sticky bottom-0 z-10">
                <tr className="border-t-2 border-slate-900 bg-slate-900 font-bold text-white">
                  <td colSpan={8} className="px-2 py-2 text-right uppercase tracking-wide">
                    Total geral ({visibleCompositionCount} composição(ões))
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(displayTotals.contractedValue)}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${BORDER_L}`}>{fmtBRL(displayTotals.materialCost)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(displayTotals.laborCost)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(displayTotals.contractedLaborCost)}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${BORDER_L}`}>{fmtBRL(displayTotals.committedCost)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtBRL(displayTotals.realCost)}</td>
                  <td
                    className={`px-2 py-2 text-right tabular-nums ${displayTotals.signal === 'incomplete' ? 'text-amber-300' : displayTotals.grossProfit >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
                  >
                    {displayTotals.certifiedContractedValue > 0 ? fmtBRL(displayTotals.grossProfit) : '—'}
                  </td>
                  <td
                    className={`px-2 py-2 text-right tabular-nums ${displayTotals.signal === 'incomplete' ? 'text-amber-300' : displayTotals.marginPct >= 15 ? 'text-emerald-300' : displayTotals.marginPct >= 5 ? 'text-amber-300' : 'text-rose-300'}`}
                  >
                    {displayTotals.certifiedContractedValue > 0 ? fmtPct(displayTotals.marginPct) : '—'}
                  </td>
                  <td className="px-2 py-2 text-center tabular-nums">{displayTotals.pendingCompositionCount}</td>
                  <td className="px-2 py-2 text-center"><SignalBadge signal={displayTotals.signal} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
          <div>
            <div className="flex items-center gap-2">
              <Layers3 className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Distribuição mensal pelo Cronograma</h2>
            </div>
            <p className="text-[11px] text-muted-foreground">Receita certificada, custo certificado, lucro e margem conforme as datas do Gantt.</p>
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
                  <th className="p-2 text-right">Receita certificada</th>
                  <th className="p-2 text-right">Custo certificado</th>
                  <th className="p-2 text-right">Lucro certificado</th>
                  <th className="p-2 text-right">Margem cert.</th>
                  <th className="p-2 text-center">Tarefas</th>
                  <th className="p-2 text-left">Comparativo visual</th>
                  <th className="p-2 text-center">Semaforo</th>
                </tr>
              </thead>
              <tbody>
                {analysis.months.map(month => (
                  <tr key={month.key} className="border-b border-border">
                    <td className="p-2 font-medium">{month.label}</td>
                    <td className="p-2 text-right tabular-nums">{fmtBRL(month.certifiedContractedValue)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtBRL(month.committedCost)}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${month.signal === 'incomplete' ? 'text-warning' : month.grossProfit >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {month.certifiedContractedValue > 0 ? fmtBRL(month.grossProfit) : '—'}
                    </td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${month.signal === 'incomplete' ? 'text-warning' : marginTone(month.marginPct)}`}>
                      {month.certifiedContractedValue > 0 ? fmtPct(month.marginPct) : '—'}
                    </td>
                    <td className="p-2 text-center tabular-nums">{month.taskCount}</td>
                    <td className="p-2">
                      <div className="space-y-1">
                        <div className="h-2 w-full rounded-full bg-muted overflow-hidden" title="Receita certificada">
                          <div
                            className="h-2 rounded-full bg-primary/80"
                            style={{ width: `${Math.max(2, (month.certifiedContractedValue / maxMonthValue) * 100)}%` }}
                          />
                        </div>
                        <div className="h-2 w-full rounded-full bg-muted overflow-hidden" title="Custo certificado">
                          <div
                            className="h-2 rounded-full bg-warning/80"
                            style={{ width: `${Math.max(2, (month.committedCost / maxMonthValue) * 100)}%` }}
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
      </>}
    </div>
  );
}
