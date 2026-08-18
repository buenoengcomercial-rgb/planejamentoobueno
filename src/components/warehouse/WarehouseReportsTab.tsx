import { useMemo } from 'react';
import type { Project } from '@/types/project';
import { computeWarehouseRows, computeWarehouseUsageByChapter, ensureWarehouse, MOVEMENT_LABEL } from '@/lib/warehouse';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';

interface Props { project: Project; }

function downloadCSV(filename: string, rows: (string | number)[][]) {
  const csv = rows.map(row => row.map(cell => {
    const value = String(cell ?? '');
    return /[",;\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join(';')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function moneyBR(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function WarehouseReportsTab({ project }: Props) {
  const warehouse = ensureWarehouse(project).warehouse!;
  const rows = useMemo(
    () => computeWarehouseRows(project, { materialOnly: true, confirmedOnly: true, includeManual: true }),
    [project],
  );
  const usage = useMemo(() => computeWarehouseUsageByChapter(project), [project]);
  const acquiredCost = useMemo(() => warehouse.fiscalNotes
    .filter(note => note.status === 'aprovada')
    .reduce((sum, note) => sum + (Number(note.totalAmount) || note.items.reduce((itemSum, item) => itemSum + Number(item.globalTotalPrice ?? item.totalPrice ?? 0), 0)), 0), [warehouse.fiscalNotes]);
  const inventoryValue = useMemo(() => rows.reduce((sum, row) => sum + Number(row.inventoryValue ?? 0), 0), [rows]);
  const incompleteValuationCount = rows.filter(row => row.valuationIncomplete).length;

  const exportMovements = () => {
    const data: (string | number)[][] = [['Data', 'Tipo', 'Origem', 'Código', 'Descrição', 'Un', 'Qtd', 'Custo unitário registrado', 'Custo total', 'Prédio / capítulo', 'Equipe', 'Operador', 'Documento']];
    for (const movement of warehouse.movements) {
      const unitCost = movement.costSnapshot ?? movement.unitPrice;
      data.push([
        movement.date,
        MOVEMENT_LABEL[movement.type],
        movement.originType ?? 'Registro legado',
        movement.itemCode ?? '',
        movement.itemDescription,
        movement.itemUnit,
        movement.quantity,
        unitCost ?? 'Cálculo incompleto',
        unitCost == null ? 'Cálculo incompleto' : +(movement.quantity * unitCost).toFixed(2),
        movement.chapterId ?? '',
        movement.teamId ?? '',
        movement.createdBy?.userName ?? movement.createdBy?.userEmail ?? 'Não registrado',
        movement.invoiceNumber ?? movement.requisitionId ?? movement.inventorySessionId ?? '',
      ]);
    }
    downloadCSV('extrato-auditavel-de-movimentacoes.csv', data);
  };

  const exportStock = () => {
    const data: (string | number)[][] = [['Código', 'Descrição', 'Un', 'Previsto', 'Comprado', 'Recebido', 'Retirado', 'Perdas', 'Saldo', 'Custo médio', 'Valor em estoque', 'Vínculo', 'Mínimo']];
    for (const row of rows) data.push([
      row.code ?? '', row.description, row.unit, row.planned, row.purchased, row.received, row.withdrawn, row.losses, row.balance,
      row.valuationIncomplete ? 'Cálculo incompleto' : row.averageUnitCost ?? 0,
      row.valuationIncomplete ? 'Cálculo incompleto' : row.inventoryValue ?? 0,
      row.linkStatus, row.minStock ?? '',
    ]);
    downloadCSV('posicao-atual-do-estoque.csv', data);
  };

  const exportAcquiredCosts = () => {
    const data: (string | number)[][] = [['Nota', 'Emissão', 'Fornecedor', 'CNPJ', 'Grupo de compra', 'Itens', 'Custo adquirido']];
    for (const note of warehouse.fiscalNotes.filter(current => current.status === 'aprovada')) {
      const groups = Array.from(new Set(note.items.map(item => item.purchaseGroupId).filter(Boolean))).join(', ');
      const total = Number(note.totalAmount) || note.items.reduce((sum, item) => sum + Number(item.globalTotalPrice ?? item.totalPrice ?? 0), 0);
      data.push([note.invoiceNumber ?? '', note.issueDate ?? '', note.supplierName ?? '', note.supplierCnpj ?? '', groups || 'Sem grupo', note.items.length, +total.toFixed(2)]);
    }
    downloadCSV('custos-adquiridos-por-nota.csv', data);
  };

  const exportConsumptionByChapter = () => {
    const data: (string | number)[][] = [['Prédio / capítulo', 'Movimentos', 'Materiais', 'Custo consumido', 'Situação do cálculo']];
    for (const row of usage.rows) data.push([row.chapter, row.movementCount, row.itemCount, row.consumedCost, row.costIncomplete ? 'Cálculo incompleto' : 'Calculado']);
    if (usage.unlinkedMovementCount) data.push(['Sem vínculo', usage.unlinkedMovementCount, '', '', 'Exige classificação']);
    downloadCSV('custo-consumido-por-predio-capitulo.csv', data);
  };

  const exportConsumptionByTeam = () => {
    const grouped = new Map<string, { quantity: number; cost: number; incomplete: boolean; movements: number }>();
    for (const movement of warehouse.movements) {
      if (movement.type !== 'retirada' || movement.reversedById) continue;
      const key = movement.teamId || 'Sem equipe';
      const current = grouped.get(key) ?? { quantity: 0, cost: 0, incomplete: false, movements: 0 };
      const unitCost = movement.costSnapshot ?? movement.unitPrice;
      current.quantity += movement.quantity;
      current.movements += 1;
      if (unitCost == null) current.incomplete = true;
      else current.cost += movement.quantity * unitCost;
      grouped.set(key, current);
    }
    const data: (string | number)[][] = [['Equipe', 'Movimentos', 'Quantidade total', 'Custo consumido', 'Situação do cálculo']];
    for (const [team, row] of grouped) data.push([team, row.movements, +row.quantity.toFixed(2), +row.cost.toFixed(2), row.incomplete ? 'Cálculo incompleto' : 'Calculado']);
    downloadCSV('custo-consumido-por-equipe.csv', data);
  };

  const exportUnderMin = () => {
    const data: (string | number)[][] = [['Código', 'Descrição', 'Un', 'Saldo', 'Mínimo', 'Faltam']];
    for (const row of rows) if (row.underMin) data.push([row.code ?? '', row.description, row.unit, row.balance, row.minStock ?? 0, (row.minStock ?? 0) - row.balance]);
    downloadCSV('materiais-abaixo-do-minimo.csv', data);
  };

  const exportOpenCustody = () => {
    const data: (string | number)[][] = [['Nº', 'Código interno', 'Equipamento', 'Marca', 'Modelo', 'Série', 'Patrimônio', 'Recebedor', 'Emitido em', 'Devolver até', 'Status']];
    for (const term of warehouse.custodyTerms) if (term.status !== 'devolvido') data.push([term.number, term.equipmentInternalCode ?? '', term.equipmentName, term.equipmentBrand ?? '', term.equipmentModel ?? '', term.equipmentSerial ?? '', term.equipmentPatrimony ?? '', term.workerName, term.issuedAt, term.dueDate ?? '', term.status]);
    downloadCSV('termos-de-cautela-em-aberto.csv', data);
  };

  const exportDivergence = () => {
    const data: (string | number)[][] = [['Descrição', 'Un', 'Previsto', 'Comprado', 'Retirado', 'Dif. previsto-retirado', 'Dif. comprado-retirado']];
    for (const row of rows) data.push([row.description, row.unit, row.planned, row.purchased, row.withdrawn, +(row.planned - row.withdrawn).toFixed(2), +(row.purchased - row.withdrawn).toFixed(2)]);
    downloadCSV('divergencia-previsto-comprado-retirado.csv', data);
  };

  const ReportCard = ({ title, description, button, onExport }: { title: string; description: string; button: string; onExport: () => void }) => (
    <div className="flex min-h-[132px] flex-col gap-3 rounded-md border bg-card p-3">
      <div className="flex-1">
        <div className="text-sm font-semibold leading-tight">{title}</div>
        <div className="mt-1 text-xs leading-snug text-muted-foreground">{description}</div>
      </div>
      <Button size="sm" variant="outline" className="min-h-10 self-start text-xs" onClick={onExport}>
        <Download className="mr-1.5 h-4 w-4" /> {button}
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded-md border bg-card p-3"><div className="text-xs font-semibold uppercase text-muted-foreground">Custo adquirido</div><div className="mt-1 text-lg font-bold tabular-nums">{moneyBR(acquiredCost)}</div><p className="text-xs text-muted-foreground">Somente notas lançadas.</p></div>
        <div className="rounded-md border bg-card p-3"><div className="text-xs font-semibold uppercase text-muted-foreground">Custo consumido</div><div className="mt-1 text-lg font-bold tabular-nums">{moneyBR(usage.totalConsumedCost)}</div><p className="text-xs text-muted-foreground">Somente retiradas, sem duplicar compras.</p></div>
        <div className="rounded-md border bg-card p-3"><div className="text-xs font-semibold uppercase text-muted-foreground">Valor atual em estoque</div><div className="mt-1 text-lg font-bold tabular-nums">{moneyBR(inventoryValue)}</div><p className="text-xs text-muted-foreground">{incompleteValuationCount ? `${incompleteValuationCount} material(is) com cálculo incompleto.` : 'Média ponderada calculada.'}</p></div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <ReportCard title="Custos adquiridos por nota" description="Compras por fornecedor, nota e grupo de compra." button="Exportar custos adquiridos" onExport={exportAcquiredCosts} />
        <ReportCard title="Custo consumido por prédio" description="Retiradas apropriadas ao prédio/capítulo pelo custo congelado na entrega." button="Exportar consumo por prédio" onExport={exportConsumptionByChapter} />
        <ReportCard title="Custo consumido por equipe" description="Consumo real agrupado pela equipe que recebeu o material." button="Exportar consumo por equipe" onExport={exportConsumptionByTeam} />
        <ReportCard title="Extrato de movimentações" description="Histórico imutável com origem, operador e custo registrado." button="Exportar extrato" onExport={exportMovements} />
        <ReportCard title="Posição de estoque" description="Previsto, recebido, retirado, saldo, vínculo e média ponderada." button="Exportar posição" onExport={exportStock} />
        <ReportCard title="Materiais abaixo do mínimo" description="Itens em ruptura ou risco de ruptura." button="Exportar estoque baixo" onExport={exportUnderMin} />
        <ReportCard title="Termos de cautela em aberto" description="Equipamentos em uso, identificação e prazo de devolução." button="Exportar cautelas" onExport={exportOpenCustody} />
        <ReportCard title="Divergência do orçamento" description="Compara material previsto, comprado e efetivamente retirado." button="Exportar divergências" onExport={exportDivergence} />
      </div>
    </div>
  );
}
