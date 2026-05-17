
# Estoque / Almoxarifado — Plano de Implementação

Vamos criar uma aba dedicada **Estoque / Almoxarifado** integrada aos módulos já existentes (Lista de Material, Pedidos, Tarefas/EAP, Diário, Medição, Aditivo). A aba atual "Estoque" dentro de Lista de Material será mantida apenas como visão rápida; o controle completo passa para a nova aba principal.

## Estrutura da nova aba

Nova entrada na sidebar **Almoxarifado**, com 7 subabas:

1. **Painel** — cards de Planejado / Comprado / Recebido / Retirado / Aplicado / Saldo / A comprar / Abaixo do mínimo / Divergência.
2. **Materiais em estoque** — lista consolidada por item com saldo calculado, estoque mínimo, local, último movimento.
3. **Movimentações** — extrato completo (entradas, retiradas, devoluções, perdas, transferências, ajustes, estornos). Não há exclusão — apenas estorno.
4. **Requisições / Retiradas** — formulário de requisição vinculada a tarefa/EAP, equipe, funcionário, frente de serviço; gera recibo PDF com assinatura digital (canvas) do almoxarife e do recebedor; opção "publicar no Diário do dia".
5. **Equipamentos & Termo de Cautela** — cadastro de equipamentos (patrimônio/série), entrega com termo PDF assinado, devolução com conferência de estado, registro de divergência/dano/perda.
6. **Inventário** — contagem física por item, gera ajustes automáticos como movimentações.
7. **Relatórios** — extrato por item, retiradas por equipe, retiradas por tarefa, abaixo do mínimo, termos em aberto, equipamentos não devolvidos, divergência planejado×comprado×retirado×medido. Exportação CSV.

## Regras de negócio

- **Saldo é sempre derivado**: `Saldo = Σ(entradas + devoluções) − Σ(retiradas + perdas + transferências_saída) ± ajustes`. Nunca editável.
- **Imutabilidade**: movimentações não são apagadas. Para corrigir, o usuário cria um **estorno** que referencia o movimento original (`reversesId`).
- **Auditoria**: cada movimento guarda `date`, `createdAt`, `user`, `responsible`, `originId` (pedido/requisição/termo), `destination` (tarefa/equipe/funcionário), `notes`, `attachments[]`.
- **Anexos** (NF, foto do material, recibo, termo) ficam em base64/URL no projeto (mesmo padrão do Diário).
- **Assinatura digital**: componente de canvas que salva PNG base64 dentro do registro.
- **Integrações**:
  - Itens vindos de `MaterialsList` (com `linkedComparisonId`) alimentam "Planejado".
  - Pedidos com status `comprado` alimentam "Esperado para entrada".
  - Entradas registradas viram saldo real.
  - Retiradas opcionalmente espelham no `dailyReports` do dia (entrada de produção/observação).
  - Aditivo atualiza quantidades planejadas via recálculo da Lista de Material (já existe).
  - Tarefa/EAP vinculada na retirada permite o cruzamento na Medição.

## Detalhes técnicos

### Tipos novos em `src/types/project.ts`
```ts
export type WarehouseMovementType =
  | 'entrada' | 'devolucao' | 'retirada' | 'perda'
  | 'transferencia_saida' | 'transferencia_entrada'
  | 'ajuste_positivo' | 'ajuste_negativo' | 'estorno';

export interface WarehouseLocation { id: string; name: string; }

export interface WarehouseItem {
  key: string;          // mesmo linkKey usado em materialComparisons
  code?: string;
  description: string;
  unit: string;
  minStock?: number;
  defaultLocationId?: string;
}

export interface WarehouseMovement {
  id: string;
  type: WarehouseMovementType;
  date: string;             // ISO
  createdAt: string;
  itemKey: string;
  itemCode?: string;
  itemDescription: string;
  itemUnit: string;
  quantity: number;
  unitPrice?: number;
  locationId?: string;
  // origens
  purchaseOrderId?: string;
  supplierId?: string;
  invoiceNumber?: string;
  // destinos
  requisitionId?: string;
  taskId?: string;
  teamId?: string;
  workerName?: string;
  workFront?: string;
  // governança
  responsible?: string;
  user?: string;
  notes?: string;
  attachments?: { name: string; dataUrl: string; kind: 'nf'|'foto'|'recibo'|'outro' }[];
  reversesId?: string;
  reversedById?: string;
  publishedToDailyReportId?: string;
}

export interface WarehouseRequisition {
  id: string;
  number: string;
  date: string;
  taskId?: string;
  teamId?: string;
  requesterName?: string;
  workFront?: string;
  notes?: string;
  items: { itemKey: string; quantity: number; unit: string; description: string; code?: string; movementId?: string }[];
  signatureWarehouse?: string;  // dataURL
  signatureReceiver?: string;
  status: 'rascunho' | 'entregue' | 'cancelada';
}

export interface Equipment {
  id: string; name: string; patrimony?: string; serial?: string;
  category?: string; notes?: string; createdAt: string;
}

export interface CustodyTerm {
  id: string; number: string; equipmentId: string;
  issuedAt: string; dueDate?: string;
  workerName: string; teamId?: string;
  accessories?: string;
  stateOnDelivery?: string;
  signatureWarehouse?: string; signatureReceiver?: string;
  status: 'em_uso' | 'devolvido' | 'divergencia' | 'perdido' | 'danificado';
  returnedAt?: string; stateOnReturn?: string;
  divergenceNotes?: string;
  attachments?: { name: string; dataUrl: string }[];
}

export interface WarehouseState {
  locations: WarehouseLocation[];
  items: WarehouseItem[];                // overrides (minStock, location) por key
  movements: WarehouseMovement[];
  requisitions: WarehouseRequisition[];
  equipments: Equipment[];
  custodyTerms: CustodyTerm[];
}
```
Campo `warehouse?: WarehouseState` adicionado em `Project`.

### Lógica em `src/lib/warehouse.ts` (novo)
- `computeBalance(movements, itemKey)` aplicando sinais por tipo.
- `computeWarehouseRows(project)` cruzando Lista de Material + Pedidos + Movimentos → Planejado/Comprado/Recebido/Retirado/Aplicado/Saldo/A comprar.
- `addMovement`, `reverseMovement`, `addRequisition`, `deliverRequisition` (cria movimentos `retirada`), `issueCustody`, `returnCustody`.
- `publishMovementToDailyReport(project, movement)` — adiciona linha em observações/produção do diário do dia.

### Componentes (novos em `src/components/warehouse/`)
- `Warehouse.tsx` (container + Tabs).
- `WarehousePanel.tsx`
- `WarehouseStockTab.tsx`
- `WarehouseMovementsTab.tsx` (+ `MovementFormDialog.tsx` com tipos entrada/retirada/perda/transf/ajuste, anexos).
- `WarehouseRequisitionsTab.tsx` (+ `RequisitionDialog.tsx`, `RequisitionReceiptPdf.tsx`).
- `WarehouseEquipmentsTab.tsx` (+ `CustodyTermDialog.tsx`, `CustodyTermPdf.tsx`).
- `WarehouseInventoryTab.tsx`
- `WarehouseReportsTab.tsx`
- `SignaturePad.tsx` (canvas → base64).

### Sidebar / Roteamento
- `src/components/AppSidebar.tsx`: adicionar item **Almoxarifado** (ícone `Warehouse`).
- `src/pages/Index.tsx` (ou router atual): novo case `warehouse` renderizando `<Warehouse project … />`.

### Persistência
- Tudo via `project.warehouse` no fluxo existente de `onProjectChange` (localStorage + Supabase já cuidam).
- Migração leve: ao carregar, se `project.warehouse` ausente, inicializar `{ locations:[], items:[], movements:[], requisitions:[], equipments:[], custodyTerms:[] }`. Movimentos antigos em `project.stockMovements` são convertidos em `WarehouseMovement` (tipo entrada/saida/ajuste → entrada/retirada/ajuste_positivo).

### Integrações concretas
- **Pedido**: botão "Registrar entrada" em `PurchaseOrderTab.tsx` abre `MovementFormDialog` pré-preenchido (fornecedor, item, qty pendente).
- **Diário**: ao confirmar retirada, opção "Publicar no Diário do dia" chama `publishMovementToDailyReport`.
- **Medição**: `WarehouseReportsTab` cruza `taskId` das retiradas com itens medidos para calcular divergência.
- **Aditivo**: já reflete em Lista de Material; cards de Planejado leem dali.

### Aba antiga
- `StockTab.tsx` dentro de Lista de Material: manter, com aviso "Para controle completo, use Almoxarifado", ou substituir por link. Decisão: **manter** somente leitura.

## Ordem de execução

1. Tipos + util `warehouse.ts` + migração.
2. Sidebar + rota + container `Warehouse.tsx` com Tabs vazias.
3. Painel + Materiais em estoque + Movimentações (com SignaturePad e anexos).
4. Requisições + recibo PDF.
5. Equipamentos + Termo de Cautela + PDF.
6. Inventário + Relatórios + integrações (Pedido → entrada, Diário, Medição cross-check).
7. Typecheck e ajustes.

## Critérios de aceite mapeados

- Entrada → saldo ↑: ✔ via `addMovement('entrada')`.
- Retirada vinculada a tarefa → saldo ↓ + histórico do item: ✔.
- Termo de cautela: ✔ gerar PDF + assinatura.
- Devolução de equipamento: ✔ `returnCustody`.
- Relatórios + exportação: ✔.
- Build sem erros: ✔ via verificação final.
