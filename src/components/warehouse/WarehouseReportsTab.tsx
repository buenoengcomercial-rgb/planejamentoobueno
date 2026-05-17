import { useMemo } from 'react';
import type { Project } from '@/types/project';
import { computeWarehouseRows, ensureWarehouse, MOVEMENT_LABEL } from '@/lib/warehouse';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { getAllTasks } from '@/data/sampleProject';

interface Props { project: Project; }

function downloadCSV(filename: string, rows: (string | number)[][]) {
  const csv = rows.map(r => r.map(c => {
    const s = String(c ?? '');
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function WarehouseReportsTab({ project }: Props) {
  const wh = ensureWarehouse(project).warehouse!;
  const rows = useMemo(() => computeWarehouseRows(project), [project]);
  const tasks = useMemo(() => getAllTasks(project), [project]);

  const exportMovements = () => {
    const data: (string | number)[][] = [['Data', 'Tipo', 'Código', 'Descrição', 'Un', 'Qtd', 'Responsável', 'Tarefa', 'NF', 'Observação']];
    for (const m of wh.movements) {
      data.push([m.date, MOVEMENT_LABEL[m.type], m.itemCode ?? '', m.itemDescription, m.itemUnit, m.quantity, m.responsible ?? m.user ?? '', m.taskId ?? '', m.invoiceNumber ?? '', m.notes ?? '']);
    }
    downloadCSV('movimentacoes.csv', data);
  };

  const exportStock = () => {
    const data: (string | number)[][] = [['Código', 'Descrição', 'Un', 'Planejado', 'Comprado', 'Recebido', 'Retirado', 'Perdas', 'Saldo', 'Mínimo']];
    for (const r of rows) data.push([r.code ?? '', r.description, r.unit, r.planned, r.purchased, r.received, r.withdrawn, r.losses, r.balance, r.minStock ?? '']);
    downloadCSV('estoque.csv', data);
  };

  const exportTaskWithdrawals = () => {
    const data: (string | number)[][] = [['Tarefa', 'Insumo', 'Un', 'Qtd retirada', 'Data', 'Responsável']];
    for (const m of wh.movements) {
      if (m.type !== 'retirada' || m.reversedById) continue;
      const t = tasks.find(x => x.id === m.taskId);
      data.push([t?.name ?? '—', m.itemDescription, m.itemUnit, m.quantity, m.date, m.workerName ?? m.responsible ?? '']);
    }
    downloadCSV('retiradas-por-tarefa.csv', data);
  };

  const exportTeamWithdrawals = () => {
    const data: (string | number)[][] = [['Equipe', 'Insumo', 'Un', 'Qtd', 'Data']];
    for (const m of wh.movements) {
      if (m.type !== 'retirada' || m.reversedById) continue;
      data.push([m.teamId ?? '—', m.itemDescription, m.itemUnit, m.quantity, m.date]);
    }
    downloadCSV('retiradas-por-equipe.csv', data);
  };

  const exportUnderMin = () => {
    const data: (string | number)[][] = [['Código', 'Descrição', 'Un', 'Saldo', 'Mínimo', 'Faltam']];
    for (const r of rows) if (r.underMin) data.push([r.code ?? '', r.description, r.unit, r.balance, r.minStock ?? 0, (r.minStock ?? 0) - r.balance]);
    downloadCSV('abaixo-do-minimo.csv', data);
  };

  const exportOpenCustody = () => {
    const data: (string | number)[][] = [['Nº', 'Equipamento', 'Patrimônio', 'Recebedor', 'Emitido em', 'Devolver até', 'Status']];
    for (const t of wh.custodyTerms) if (t.status !== 'devolvido') data.push([t.number, t.equipmentName, t.equipmentPatrimony ?? '', t.workerName, t.issuedAt, t.dueDate ?? '', t.status]);
    downloadCSV('termos-em-aberto.csv', data);
  };

  const exportDivergence = () => {
    const data: (string | number)[][] = [['Descrição', 'Un', 'Planejado', 'Comprado', 'Retirado', 'Δ Plan-Retirado', 'Δ Comp-Retirado']];
    for (const r of rows) data.push([r.description, r.unit, r.planned, r.purchased, r.withdrawn, +(r.planned - r.withdrawn).toFixed(2), +(r.purchased - r.withdrawn).toFixed(2)]);
    downloadCSV('divergencia-plan-comp-retirado.csv', data);
  };

  const ReportCard = ({ title, desc, onExport }: { title: string; desc: string; onExport: () => void }) => (
    <div className="bg-card border border-border rounded-lg p-3 flex flex-col gap-2">
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-[11px] text-muted-foreground">{desc}</div>
      </div>
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onExport}><Download className="w-3 h-3 mr-1" /> Exportar CSV</Button>
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      <ReportCard title="Extrato de movimentações" desc="Todas as entradas, retiradas, perdas e ajustes." onExport={exportMovements} />
      <ReportCard title="Posição de estoque" desc="Planejado × Comprado × Recebido × Retirado × Saldo." onExport={exportStock} />
      <ReportCard title="Retiradas por tarefa/EAP" desc="Material retirado vinculado a cada tarefa." onExport={exportTaskWithdrawals} />
      <ReportCard title="Retiradas por equipe" desc="Consumo agrupado por equipe." onExport={exportTeamWithdrawals} />
      <ReportCard title="Abaixo do estoque mínimo" desc="Itens em ruptura ou risco de ruptura." onExport={exportUnderMin} />
      <ReportCard title="Termos de cautela em aberto" desc="Equipamentos em uso e não devolvidos." onExport={exportOpenCustody} />
      <ReportCard title="Divergência planejado × retirado" desc="Material aplicado vs orçamento e compra." onExport={exportDivergence} />
    </div>
  );
}
