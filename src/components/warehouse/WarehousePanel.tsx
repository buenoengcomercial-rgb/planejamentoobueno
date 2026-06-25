import type { Project } from '@/types/project';
import {
  panelSummary,
  computeWarehouseRows,
  ensureWarehouse,
  computeWarehouseUsageByChapter,
  computeWarehouseMonthlyCosts,
} from '@/lib/warehouse';
import { useMemo } from 'react';
import { AlertTriangle, PackagePlus, ClipboardList, FileWarning, MapPinned, ReceiptText, CalendarDays } from 'lucide-react';

interface Props { project: Project; }

const StatCard = ({ label, value, tone, hint }: { label: string; value: string | number; tone?: 'ok' | 'warn' | 'danger' | 'primary'; hint?: string }) => {
  const toneClass =
    tone === 'ok' ? 'text-success' :
    tone === 'warn' ? 'text-warning' :
    tone === 'danger' ? 'text-destructive' :
    tone === 'primary' ? 'text-primary' : 'text-foreground';
  return (
    <div className="bg-card border border-border rounded-md p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${toneClass}`}>{typeof value === 'number' ? value.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
};

function moneyBR(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function WarehousePanel({ project }: Props) {
  const s = useMemo(() => panelSummary(project), [project]);
  const rows = useMemo(
    () => computeWarehouseRows(project, { materialOnly: true, confirmedOnly: true, includeManual: true }),
    [project],
  );
  const usageByChapter = useMemo(() => computeWarehouseUsageByChapter(project), [project]);
  const monthlyCosts = useMemo(() => computeWarehouseMonthlyCosts(project), [project]);
  const wh = ensureWarehouse(project).warehouse!;
  const underMin = rows.filter(r => r.underMin).slice(0, 8);
  const hasMovements = wh.movements.length > 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
        <StatCard label="Perdas" value={s.totalLosses} tone="danger" />
        <StatCard label="Abaixo do mínimo" value={s.underMinCount} tone={s.underMinCount > 0 ? 'danger' : undefined} />
        <StatCard label="Termos em aberto" value={s.openCustodyCount} />
        <StatCard label="Termos vencidos" value={s.overdueCustodyCount} tone={s.overdueCustodyCount > 0 ? 'danger' : undefined} />
        <StatCard label="Divergência > 10%" value={s.divergenceCount} tone={s.divergenceCount > 0 ? 'warn' : undefined} />
      </div>

      <div className="bg-card border border-border rounded-md p-3">
        <div className="text-xs font-semibold mb-2 flex items-center gap-1.5">
          <ReceiptText className="w-3.5 h-3.5 text-primary" /> Faturas das notas fiscais
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <StatCard label="A pagar" value={moneyBR(s.invoiceOpen)} tone={s.invoiceOpen > 0 ? 'warn' : undefined} hint={`${s.invoiceOpenCount} fatura(s) aberta(s)`} />
          <StatCard label="Vencidas" value={moneyBR(s.invoiceOverdue)} tone={s.invoiceOverdue > 0 ? 'danger' : undefined} hint={`${s.invoiceOverdueCount} fatura(s) vencida(s)`} />
          <StatCard label="Pagas" value={moneyBR(s.invoicePaid)} tone="ok" />
          <StatCard label="Total faturado" value={moneyBR(s.invoiceTotal)} tone="primary" />
        </div>
      </div>

      <div className="bg-card border border-border rounded-md p-3">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <div className="text-xs font-semibold flex items-center gap-1.5">
              <CalendarDays className="w-3.5 h-3.5 text-primary" /> Pagamentos e custos por mes
            </div>
            <div className="text-[11px] text-muted-foreground">
              Usa a data da fatura/parcela; sem fatura preenchida, usa a data de emissao da nota fiscal.
            </div>
          </div>
        </div>

        {monthlyCosts.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center border border-dashed border-border rounded-md">
            Ainda nao ha notas fiscais aprovadas para montar o custo mensal.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left p-1">Mes</th>
                  <th className="text-right p-1">Custo total</th>
                  <th className="text-right p-1">Pago</th>
                  <th className="text-right p-1">Em aberto</th>
                  <th className="text-right p-1">Vencido</th>
                  <th className="text-center p-1">Faturas</th>
                  <th className="text-center p-1">Notas</th>
                  <th className="text-left p-1">Referencia</th>
                </tr>
              </thead>
              <tbody>
                {monthlyCosts.slice(0, 12).map(row => (
                  <tr key={row.monthKey} className="border-t border-border">
                    <td className="p-1 font-medium capitalize">{row.monthLabel}</td>
                    <td className="p-1 text-right font-semibold tabular-nums">{moneyBR(row.total)}</td>
                    <td className="p-1 text-right tabular-nums text-success">{moneyBR(row.paid)}</td>
                    <td className="p-1 text-right tabular-nums text-warning">{moneyBR(row.open)}</td>
                    <td className={`p-1 text-right tabular-nums ${row.overdue > 0 ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
                      {moneyBR(row.overdue)}
                    </td>
                    <td className="p-1 text-center tabular-nums">{row.invoiceCount}</td>
                    <td className="p-1 text-center tabular-nums">{row.noteCount}</td>
                    <td className="p-1 text-[11px] text-muted-foreground">
                      {row.fallbackCount > 0
                        ? `${row.fallbackCount} nota(s) pela emissao`
                        : 'Fatura / pagamento'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!hasMovements && (
        <div className="bg-card border border-border rounded-md p-4">
          <div className="text-xs font-semibold mb-2 flex items-center gap-1.5"><ClipboardList className="w-3.5 h-3.5 text-primary" /> Próximas ações</div>
          <div className="text-xs text-muted-foreground mb-3">Registre uma entrada de material para iniciar o controle de estoque.</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="border border-dashed border-border rounded-md p-3 flex items-start gap-2">
              <PackagePlus className="w-4 h-4 text-primary mt-0.5" />
              <div>
                <div className="text-xs font-medium">Registrar entrada</div>
                <div className="text-[11px] text-muted-foreground">Vá em Movimentações → Nova movimentação.</div>
              </div>
            </div>
            <div className="border border-dashed border-border rounded-md p-3 flex items-start gap-2">
              <ClipboardList className="w-4 h-4 text-primary mt-0.5" />
              <div>
                <div className="text-xs font-medium">Criar requisição</div>
                <div className="text-[11px] text-muted-foreground">Vincule a retirada a uma tarefa da EAP.</div>
              </div>
            </div>
            <div className="border border-dashed border-border rounded-md p-3 flex items-start gap-2">
              <FileWarning className="w-4 h-4 text-primary mt-0.5" />
              <div>
                <div className="text-xs font-medium">Definir mínimos</div>
                <div className="text-[11px] text-muted-foreground">Configure estoque mínimo em Materiais.</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-md p-3">
        <div className="text-xs font-semibold mb-2 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-warning" /> Materiais abaixo do estoque mínimo
        </div>
        {underMin.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center border border-dashed border-border rounded-md">
            Tudo certo. Nenhum item abaixo do mínimo configurado.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left p-1">Descrição</th>
                <th className="text-center p-1 w-12">Un</th>
                <th className="text-right p-1 w-20">Saldo</th>
                <th className="text-right p-1 w-20">Mínimo</th>
              </tr>
            </thead>
            <tbody>
              {underMin.map(r => (
                <tr key={r.key} className="border-t border-border">
                  <td className="p-1">{r.description}</td>
                  <td className="p-1 text-center">{r.unit}</td>
                  <td className="p-1 text-right font-mono text-destructive">{r.balance.toLocaleString('pt-BR')}</td>
                  <td className="p-1 text-right font-mono">{r.minStock?.toLocaleString('pt-BR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-card border border-border rounded-md p-3">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <div className="text-xs font-semibold flex items-center gap-1.5">
              <MapPinned className="w-3.5 h-3.5 text-primary" /> Consumo por capitulo da obra
            </div>
            <div className="text-[11px] text-muted-foreground">
              Retiradas vinculadas aos capitulos principais da obra.
            </div>
          </div>
          {usageByChapter.unlinkedMovementCount > 0 && (
            <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
              {usageByChapter.unlinkedMovementCount} sem vinculo
            </span>
          )}
        </div>

        {usageByChapter.rows.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center border border-dashed border-border rounded-md">
            Ainda nao ha retirada vinculada a capitulo. Ao registrar uma retirada, selecione o capitulo principal da obra.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left p-1">Capitulo</th>
                <th className="text-center p-1 w-20">Tarefas</th>
                <th className="text-center p-1 w-20">Itens</th>
                <th className="text-left p-1">Principais materiais retirados</th>
                <th className="text-right p-1 w-24">Ultima saida</th>
              </tr>
            </thead>
            <tbody>
              {usageByChapter.rows.slice(0, 8).map(row => (
                <tr key={row.phaseId} className="border-t border-border">
                  <td className="p-1 font-medium">{row.chapter}</td>
                  <td className="p-1 text-center tabular-nums">{row.taskCount}</td>
                  <td className="p-1 text-center tabular-nums">{row.itemCount}</td>
                  <td className="p-1 text-[11px] text-muted-foreground">
                    {row.items.map(item => `${item.description}: ${item.quantity.toLocaleString('pt-BR')} ${item.unit}`).join(' | ')}
                  </td>
                  <td className="p-1 text-right tabular-nums text-muted-foreground">{row.lastMovementDate ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
