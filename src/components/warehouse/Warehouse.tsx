import { useEffect, useMemo, useState } from 'react';
import type { Project, WarehouseAuditActor } from '@/types/project';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LayoutDashboard, Boxes, ArrowLeftRight, ClipboardList, HardHat, ListChecks, FileBarChart, Warehouse as WarehouseIcon, RotateCcw, ReceiptText, Settings2, LockKeyhole, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ensureWarehouse, panelSummary } from '@/lib/warehouse';
import WarehousePanel from './WarehousePanel';
import WarehouseStockTab from './WarehouseStockTab';
import WarehouseMovementsTab from './WarehouseMovementsTab';
import WarehouseRequisitionsTab from './WarehouseRequisitionsTab';
import WarehouseEquipmentsTab from './WarehouseEquipmentsTab';
import WarehouseInventoryTab from './WarehouseInventoryTab';
import WarehouseReportsTab from './WarehouseReportsTab';
import WarehouseFiscalNotesTab from './WarehouseFiscalNotesTab';
import './warehouse-visual.css';

const WAREHOUSE_TABS = [
  { value: 'notas', label: 'Notas fiscais', icon: ReceiptText },
  { value: 'estoque', label: 'Materiais', icon: Boxes },
  { value: 'requisicoes', label: 'Retiradas', icon: ClipboardList },
  { value: 'movimentos', label: 'Movimentações', icon: ArrowLeftRight },
  { value: 'inventario', label: 'Inventário', icon: ListChecks },
  { value: 'equipamentos', label: 'Equipamentos', icon: HardHat },
  { value: 'painel', label: 'Painel', icon: LayoutDashboard },
  { value: 'relatorios', label: 'Relatórios', icon: FileBarChart },
] as const;

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
  canManageFiscalNotes?: boolean;
  canApproveInventory?: boolean;
  canClearWarehouse?: boolean;
  onClearWarehouse?: (password: string) => Promise<void>;
  auditActor?: WarehouseAuditActor;
}

export default function Warehouse({ project, onProjectChange, canManageFiscalNotes = true, canApproveInventory = true, canClearWarehouse = false, onClearWarehouse, auditActor }: Props) {
  const [tab, setTab] = useState('notas');
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearPassword, setClearPassword] = useState('');
  const [clearError, setClearError] = useState('');
  const [clearing, setClearing] = useState(false);
  const ensured = useMemo(() => ensureWarehouse(project), [project]);
  useEffect(() => {
    if (ensured !== project) onProjectChange(ensured);
  }, [ensured, project, onProjectChange]);
  const summary = useMemo(() => panelSummary(ensured), [ensured]);

  const handleClearWarehouse = async () => {
    if (!onClearWarehouse || !clearPassword || clearing) return;
    setClearing(true);
    setClearError('');
    try {
      await onClearWarehouse(clearPassword);
      setClearPassword('');
      setClearDialogOpen(false);
    } catch (error) {
      setClearError(error instanceof Error ? error.message : 'Não foi possível limpar o almoxarifado.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="warehouse-ui space-y-4 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-4">
      <div className="flex flex-wrap items-start gap-3 rounded-xl border border-primary/15 bg-gradient-to-r from-primary/10 via-card to-card p-4 shadow-sm">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <WarehouseIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0">
          <h2 className="text-xl font-extrabold sm:text-2xl">Estoque e Almoxarifado</h2>
          <p className="mt-1 text-sm font-medium text-muted-foreground">Escolha uma área para consultar ou registrar uma operação.</p>
          </div>
        </div>
        <span className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto">
          Abaixo do mínimo: <strong className="text-destructive">{summary.underMinCount}</strong>
          <span className="mx-1.5">·</span>
          Termos abertos: <strong className="text-foreground">{summary.openCustodyCount}</strong>
        </span>
        {canClearWarehouse && onClearWarehouse && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="min-h-11"><Settings2 className="mr-1.5 h-4 w-4" /> Administração</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => {
                  setClearPassword('');
                  setClearError('');
                  setClearDialogOpen(true);
                }}
              >
                <RotateCcw className="mr-2 h-4 w-4" /> Limpar almoxarifado
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <div className="lg:hidden">
          <label htmlFor="warehouse-mobile-tab" className="mb-1.5 block text-xs font-semibold text-muted-foreground">Área do almoxarifado</label>
          <select
            id="warehouse-mobile-tab"
            className="min-h-12 w-full rounded-lg border-2 border-primary/30 bg-card px-3 text-base font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={tab}
            onChange={event => setTab(event.target.value)}
          >
            {WAREHOUSE_TABS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>
        <TabsList className="hidden h-auto min-h-12 w-full justify-start overflow-x-auto rounded-xl border bg-muted/70 p-1.5 shadow-sm lg:flex">
          {WAREHOUSE_TABS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className="min-h-11 rounded-lg px-3 text-xs font-bold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Icon className="mr-1 h-3.5 w-3.5" /> {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="painel" className="mt-3">
          <WarehousePanel project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} />
        </TabsContent>
        <TabsContent value="estoque" className="mt-3">
          <WarehouseStockTab project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} />
        </TabsContent>
        <TabsContent value="notas" className="mt-3">
          <WarehouseFiscalNotesTab
            project={ensured}
            onProjectChange={onProjectChange}
            canManage={canManageFiscalNotes}
            auditActor={auditActor}
          />
        </TabsContent>
        <TabsContent value="movimentos" className="mt-3">
          <WarehouseMovementsTab project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} />
        </TabsContent>
        <TabsContent value="requisicoes" className="mt-3">
          <WarehouseRequisitionsTab project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} />
        </TabsContent>
        <TabsContent value="equipamentos" className="mt-3">
          <WarehouseEquipmentsTab project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} />
        </TabsContent>
        <TabsContent value="inventario" className="mt-3">
          <WarehouseInventoryTab project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} canApprove={canApproveInventory} />
        </TabsContent>
        <TabsContent value="relatorios" className="mt-3">
          <WarehouseReportsTab project={ensured} />
        </TabsContent>
      </Tabs>
      <Dialog
        open={clearDialogOpen}
        onOpenChange={(open) => {
          if (clearing) return;
          setClearDialogOpen(open);
          if (!open) {
            setClearPassword('');
            setClearError('');
          }
        }}
      >
        <DialogContent className="warehouse-ui max-h-[calc(100dvh-2rem)] overflow-y-auto [&>button]:h-11 [&>button]:w-11 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><LockKeyhole className="h-5 w-5 text-destructive" /> Acesso exclusivo do proprietário</DialogTitle>
            <DialogDescription>
              Esta operação limpa entradas, retiradas, notas fiscais, materiais e configurações do almoxarifado. Equipamentos e os demais módulos da obra serão preservados.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="warehouse-owner-password">Confirme a senha da sua conta</Label>
            <Input
              id="warehouse-owner-password"
              className="min-h-11 text-base"
              type="password"
              autoComplete="current-password"
              value={clearPassword}
              onChange={(event) => setClearPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleClearWarehouse();
              }}
              disabled={clearing}
              autoFocus
            />
            {clearError && <p role="alert" className="text-sm text-destructive">{clearError}</p>}
            <p className="text-xs text-muted-foreground">A senha não é armazenada. A operação ficará registrada na auditoria.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setClearDialogOpen(false)} disabled={clearing}>Cancelar</Button>
            <Button type="button" variant="destructive" className="min-h-11" onClick={() => void handleClearWarehouse()} disabled={!clearPassword || clearing}>
              {clearing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirmar e limpar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
