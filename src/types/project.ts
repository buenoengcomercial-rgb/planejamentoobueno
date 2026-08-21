export interface LaborComposition {
  id: string;
  role: string; // e.g. "Encanador", "Ajudante"
  rup: number; // hours per unit (h/un)
  workerCount: number;
  hourlyRate?: number;
  /** Nome original do insumo de mão de obra vindo da composição analítica. */
  originalRole?: string;
  /** Cargo operacional normalizado usado apenas para planejamento executivo. */
  operationalRoleId?: string;
  /** Quando true, o insumo permanece no custo, mas não entra no histograma de equipe. */
  dimensioningIgnored?: boolean;
  /** Etapa sequencial da tarefa. Funcoes da mesma etapa trabalham em paralelo. */
  executionStage?: number;
}

export interface OperationalRole {
  id: string;
  name: string;
  category: 'gestao' | 'tecnica' | 'operacional' | 'apoio';
  defaultDailyHours: number;
  hourlyCost?: number;
  dailyCost?: number;
  active: boolean;
  notes?: string;
}

export type LaborNormalizationType =
  | 'cargo_operacional'
  | 'custo_acessorio'
  | 'ignorar_no_dimensionamento'
  | 'revisar_manualmente';

export interface LaborNormalizationRule {
  id: string;
  originalName: string;
  sourceBank?: string;
  sourceCode?: string;
  unit?: string;
  originalClass?: MaterialCostClass;
  parentComposition?: string;
  operationalRoleId?: string;
  normalizationType: LaborNormalizationType;
  active: boolean;
  note?: string;
  automaticRuleApplied?: string;
  manuallyReviewed?: boolean;
  applyToSimilar?: boolean;
  changedBy?: string;
  changedAt?: string;
  previousRule?: string;
}

export interface LaborAvailability {
  id: string;
  operationalRoleId: string;
  quantity: number;
  dailyHours: number;
  hourlyCost?: number;
  dailyCost?: number;
  notes?: string;
}

export interface LaborDimensioningSettings {
  defaultDailyHours: number;
  workSaturday: boolean;
  workSunday: boolean;
  overloadTolerancePercent: number;
  roundingMode: 'ceil';
  mode: 'duration_by_team' | 'team_by_deadline';
}

export interface TeamMemberDefinition {
  operationalRoleId: string;
  quantity: number;
  dailyHours?: number;
}

export type DependencyType = 'TI' | 'II' | 'TT' | 'IT';
import type { TeamCode, TeamDefinition } from '@/lib/teams';
export type { TeamCode, TeamDefinition } from '@/lib/teams';

export interface TaskDependency {
  taskId: string;
  type: DependencyType;
}

export interface TaskLocation {
  torre?: string;
  pavimento?: number;
  bloco?: string;
  ambiente?: string;
}

export interface Task {
  id: string;
  name: string;
  phase: string;
  startDate: string;
  duration: number;
  dependencies: string[];
  dependencyDetails?: TaskDependency[];
  responsible: string;
  percentComplete: number;
  materials: Material[];
  children?: Task[];
  isExpanded?: boolean;
  level: number;
  // Location & organization
  location?: TaskLocation;
  team?: TeamCode;
  frenteServico?: string;
  disciplina?: string;
  ordemExecucao?: number;
  /**
   * Contract order belongs to the public sheet structure and is used by
   * Medicao, Aditivo and Custo Real. Schedule order belongs only to the
   * executive planning views, so dragging a task in Cronograma must not
   * reorder the contract arrays shared with the official tables.
   */
  contractOrder?: number;
  originalOrder?: number;
  publicSheetOrder?: number;
  scheduleOrder?: number;
  ganttOrder?: number;
  observations?: string;
  // Duration mode
  durationMode?: 'manual' | 'rup';
  isManual?: boolean;
  manualDuration?: number;
  // RUP fields
  quantity?: number;
  unit?: string;
  /** Preço unitário contratado (R$/unidade). Usado na Planilha de Medição. */
  unitPrice?: number;
  /** Preço unitário SEM BDI (R$/unidade). Se ausente, deriva-se de unitPrice/(1+BDI). */
  unitPriceNoBDI?: number;
  /** Código do item (referência SINAPI/orçamento). */
  itemCode?: string;
  /** Número do item da Sintética que originou a tarefa (ex.: "1.1.1"). */
  contractItem?: string;
  /** Banco de referência do preço (ex.: SINAPI, SBC, próprio). */
  priceBank?: string;
  laborCompositions?: LaborComposition[];
  // CPM fields (computed)
  es?: number;
  ef?: number;
  ls?: number;
  lf?: number;
  float?: number;
  isCritical?: boolean;
  bottleneckRole?: string;
  calculatedDuration?: number;
  totalHours?: number;
  /** Horas de calendario determinadas pelos gargalos das etapas. */
  calendarHours?: number;
  // Daily production tracking
  dailyLogs?: DailyProductionLog[];
  executedQuantityTotal?: number;
  remainingQuantity?: number;
  accumulatedDelayQuantity?: number;
  recalculatedDuration?: number;
  forecastEndDate?: string;
  physicalProgress?: number;
  originalDuration?: number; // snapshot before daily-log adjustment
  // Baseline (linha de base fixa) e Current (cronograma variável)
  baseline?: TaskBaseline;
  current?: TaskCurrent;
  // ----- Origem em Aditivo (quando criada por integração de aditivo contratado) -----
  /** Aditivo de origem (quando a tarefa foi criada por integração de aditivo). */
  originAdditiveId?: string;
  originAdditiveName?: string;
  originAdditiveVersion?: number;
  /** Histórico de acréscimos/supressões aplicados a esta tarefa por aditivos integrados. */
  additiveHistory?: TaskAdditiveHistoryEntry[];
  /** True quando esta tarefa foi suprimida por aditivo (qty final = 0). Mantida visível. */
  suppressedByAdditive?: boolean;
}

/** Entrada de histórico de aplicação de aditivo a uma tarefa existente. */
export interface TaskAdditiveHistoryEntry {
  additiveId: string;
  additiveName: string;
  version: number;
  /** ISO timestamp da integração. */
  at: string;
  /** Tipo da movimentação aplicada. */
  kind?: 'novo' | 'acrescimo' | 'supressao' | 'alteracao_preco';
  addedQuantity: number;
  suppressedQuantity: number;
  previousQuantity: number;
  newQuantity: number;
  /** Valor unitário c/ BDI antes/depois (quando aplicável). */
  previousUnitPriceWithBDI?: number;
  newUnitPriceWithBDI?: number;
  /** Total c/ BDI antes/depois (quando aplicável). */
  previousTotalWithBDI?: number;
  newTotalWithBDI?: number;
  /** Usuário/responsável pela integração, quando disponível. */
  user?: string;
}

export interface TaskBaseline {
  startDate: string;
  duration: number;
  endDate: string;
  plannedDailyProduction?: number;
  quantity?: number;
  capturedAt: string;
}

export interface TaskCurrent {
  startDate: string;
  duration: number;
  endDate: string;
  forecastEndDate?: string;
  executedQuantityTotal?: number;
  remainingQuantity?: number;
  accumulatedDelayQuantity?: number;
  physicalProgress?: number;
}

export interface DailyProductionLog {
  id: string;
  date: string;            // ISO yyyy-mm-dd
  plannedQuantity: number;
  actualQuantity: number;
  notes?: string;
  /** Horas efetivamente apontadas por funcao ou trabalhador. */
  laborEntries?: DailyLaborEntry[];
}

export interface Material {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  status: 'pendente' | 'comprado';
  estimatedCost?: number;
}

export interface Phase {
  id: string;
  name: string;
  color: string;
  tasks: Task[];
  /**
   * Hierarquia de capítulos:
   * - parentId === undefined  → capítulo principal
   * - parentId === string     → subcapítulo, filho do capítulo principal indicado
   */
  parentId?: string;
  /** Ordem manual dentro do mesmo nível. */
  order?: number;
  /** Numeração customizada do capítulo (sobrescreve o automático "1", "1.1", etc). */
  customNumber?: string;
}

export interface ProjectUiState {
  /** IDs de capítulos/subcapítulos atualmente recolhidos na aba Tarefas (EAP). */
  collapsedPhaseIds?: string[];
  /** IDs de capítulos/subcapítulos atualmente recolhidos na aba Cronograma (Gantt). */
  ganttCollapsedPhaseIds?: string[];
  /** Última data inicial da Medição já aplicada ao deslocamento global do cronograma. */
  ganttWorkStartDateApplied?: string;
}

export interface ContractInfo {
  contractor?: string;     // Contratante
  contracted?: string;     // Contratada
  contractNumber?: string;
  nextMeasurementNumber?: number;
  /** Objeto do contrato (escopo resumido). */
  contractObject?: string;
  /** Local / município da obra. */
  location?: string;
  /** Fonte de orçamento (ex.: SINAPI 07/2024). */
  budgetSource?: string;
  /** BDI em % (ex.: 25 representa 25%). */
  bdiPercent?: number;
  biddingDiscountPercent?: number;
  /** Nº da ART (Anotação de Responsabilidade Técnica). */
  artNumber?: string;
}

export type ContractRevisionStatus = 'draft' | 'under_review' | 'approved' | 'contracted' | 'rejected' | 'cancelled';
export type ContractChangeType = 'new_item' | 'quantity_increase' | 'quantity_suppression' | 'price_change' | 'term_change';

export interface ContractChange {
  id: string;
  revisionId: string;
  type: ContractChangeType;
  budgetItemId?: string;
  canonicalKey?: string;
  previousQuantity?: number;
  quantityDelta?: number;
  revisedQuantity?: number;
  previousUnitPriceWithBDI?: number;
  revisedUnitPriceWithBDI?: number;
  previousEndDate?: string;
  revisedEndDate?: string;
  reason: string;
}

export interface ContractRevision {
  id: string;
  number: number;
  name: string;
  status: ContractRevisionStatus;
  effectiveDate?: string;
  createdAt: string;
  createdBy?: string;
  contractedAt?: string;
  contractedBy?: string;
  changes: ContractChange[];
}

export interface ContractRectification {
  id: string;
  reason: string;
  entityType: 'contract' | 'budget_item' | 'structure';
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: string;
  createdBy: string;
}

export type CostLedgerLevel = 'committed' | 'actual' | 'paid';
export type CostLedgerCategory = 'material' | 'labor' | 'equipment' | 'other';

export interface CostLedgerEntry {
  id: string;
  taskId?: string;
  budgetItemId?: string;
  category: CostLedgerCategory;
  level: CostLedgerLevel;
  amount: number;
  quantity?: number;
  unitPrice?: number;
  occurredAt: string;
  sourceType: 'purchase_order' | 'stock_issue' | 'daily_labor' | 'equipment_usage' | 'invoice' | 'manual';
  sourceId?: string;
  notes?: string;
}

export interface DailyLaborEntry {
  id: string;
  workerId?: string;
  workerName?: string;
  role: string;
  teamCode?: string;
  hours: number;
  hourlyCost: number;
}

export type MeasurementStatus =
  | 'draft'         // Rascunho — totalmente editável
  | 'generated'     // Gerada — bloqueada para edição
  | 'in_review'     // Em análise fiscal — bloqueada
  | 'approved'      // Aprovada — bloqueada
  | 'rejected';     // Reprovada / Ajustar — destrava edição limitada

export interface MeasurementSnapshotItem {
  item: string;
  phaseId: string;
  phaseChain: string;
  taskId: string;
  description: string;
  unit: string;
  itemCode: string;
  priceBank: string;
  qtyContracted: number;
  unitPriceNoBDI: number;
  unitPriceWithBDI: number;
  /** Quantidade originalmente proposta na geração da medição. */
  qtyProposed: number;
  /** Quantidade aprovada pelo fiscal (opcional). Quando preenchida, prevalece nos cálculos. */
  qtyApproved?: number;
  /** Acumulado anterior (somatório fora do período). */
  qtyPriorAccum: number;
  /** Observação livre por item. */
  notes?: string;
}

export interface MeasurementChangeLog {
  at: string;          // ISO
  field: string;
  itemId?: string;     // taskId quando aplicável
  previous: string;
  next: string;
  reason?: string;
}

export interface DailyReportSnapshotData {
  startDate: string;
  endDate: string;
  totalDays: number;
  filledReports: number;
  missingReports: number;
  productionDays: number;
  noProductionDays: number;
  impedimentDays: number;
  reportDates: string[];
}

export interface SavedMeasurement {
  id: string;
  number: number;
  startDate: string;
  endDate: string;
  issueDate: string;
  status: MeasurementStatus;
  bdiPercent: number;
  notes?: string;
  items: MeasurementSnapshotItem[];
  /** Histórico de alterações após a geração. */
  history?: MeasurementChangeLog[];
  /** Capturado no momento da geração para o cabeçalho do boletim. */
  contractSnapshot?: ContractInfo;
  /** Carimbo de geração. */
  generatedAt?: string;
  /** Resumo dos Diários de Obra do período da medição (capturado na geração). */
  dailyReportSnapshot?: DailyReportSnapshotData;
  /** Quando true e status='rejected', libera edição controlada do snapshot. */
  editUnlocked?: boolean;
  /** Revisao contratual vigente congelada no momento da geracao. */
  contractRevisionId?: string;
  contractRevisionNumber?: number;
}

/** Rascunho da medição em preparação (filtros não-persistidos em snapshot). */
export interface MeasurementDraft {
  /** Número da medição em preparação a que estes filtros se referem. */
  number: number;
  startDate?: string;
  endDate?: string;
  chapterFilter?: string;
  search?: string;
}

/** Estado visual persistido da tela de Medição (apenas UI: aberto/fechado). */
export interface MeasurementUiState {
  /**
   * IDs de capítulos/subcapítulos colapsados, agrupados pelo activeId em uso
   * (ex.: "live", ou o id de uma medição gerada). Permite preservar estado
   * diferente entre live e snapshots.
   */
  collapsedByActiveId?: Record<string, string[]>;
}

export type WeatherCondition = 'ensolarado' | 'nublado' | 'chuvoso' | 'parcialmente_nublado' | 'outro';
export type WorkCondition = 'normal' | 'parcialmente_prejudicada' | 'paralisada' | 'outro';

export interface DailyReportTeamRow {
  id: string;
  /** Código da equipe cadastrada no projeto (preferencial). */
  teamCode?: string;
  /** Nome livre — fallback para diários antigos sem teamCode. */
  name: string;
  role?: string;
  count?: number;
  notes?: string;
}

export interface DailyReportEquipmentRow {
  id: string;
  name: string;
  count?: number;
  notes?: string;
}

export interface DailyReportAttachment {
  id: string;
  type?: 'image' | 'file';
  fileName?: string;
  mimeType?: string;
  /** dataURL embutido (fallback / antigos diários sem Storage). */
  dataUrl?: string;
  /** Caminho no Storage do bucket `daily-report-photos`. */
  storagePath?: string;
  /** URL pública servida pelo Storage. */
  publicUrl?: string;
  /** Legenda livre da foto. */
  caption?: string;
  /** Vínculo opcional com a tarefa apontada no dia. */
  taskId?: string;
  taskName?: string;
  /** Cadeia "Capítulo > Subcapítulo" (informativa). */
  phaseChain?: string;
  quantity?: number;
  unit?: string;
  uploadedBy?: string;
  /** ISO timestamp. */
  uploadedAt?: string;
  /** Compat: alguns diários antigos podem só guardar `name`. */
  name?: string;
}

export interface DailyReport {
  id: string;
  date: string;
  /** Declaração explícita de que não houve produção no dia. */
  noProductionDeclared?: boolean;
  responsible?: string;
  weather?: WeatherCondition;
  weatherOther?: string;
  workCondition?: WorkCondition;
  workConditionOther?: string;
  teamsPresent?: DailyReportTeamRow[];
  equipment?: DailyReportEquipmentRow[];
  occurrences?: string;
  impediments?: string;
  observations?: string;
  attachments?: DailyReportAttachment[];
  createdAt: string;
  updatedAt: string;
}

export type ManagementChecklistStatus = 'pendente' | 'feito' | 'nao_aplicavel';
export type ManagementActionStatus = 'aberta' | 'em_andamento' | 'concluida' | 'cancelada';

export interface ManagementRoleAssignment {
  id: string;
  role:
    | 'gestor_obra'
    | 'mestre_encarregado'
    | 'compras'
    | 'medicao'
    | 'diario_obra'
    | 'almoxarifado'
    | 'financeiro'
    | 'qualidade';
  personName: string;
  approvalPersonName?: string;
  notes?: string;
}

export interface ManagementChecklistItem {
  id: string;
  title: string;
  ownerRole?: ManagementRoleAssignment['role'];
  status: ManagementChecklistStatus;
  notes?: string;
  updatedAt?: string;
}

export interface ManagementMeetingAction {
  id: string;
  title: string;
  responsible?: string;
  dueDate?: string;
  status: ManagementActionStatus;
}

export interface ManagementWeeklyMeeting {
  id: string;
  date: string;
  participants?: string;
  problems?: string;
  decisions?: string;
  nextPending?: string;
  actions: ManagementMeetingAction[];
  createdAt: string;
  updatedAt: string;
}

export type ManagementWeeklyTaskStatus = 'planejada' | 'cumprida' | 'parcial' | 'nao_cumprida' | 'reprogramar';

export interface ManagementWeeklyPlanItem {
  id: string;
  taskId: string;
  weekStart: string;
  weekEnd: string;
  plannedQuantity: number;
  actualQuantity?: number;
  teamCode?: TeamCode;
  responsible?: string;
  status?: ManagementWeeklyTaskStatus;
  notes?: string;
  updatedAt: string;
}

export interface ManagementRoutine {
  responsibleName?: string;
  foremanName?: string;
  buyerName?: string;
  measurementResponsibleName?: string;
  dailyReportResponsibleName?: string;
  weeklyMeetingDay?: string;
  measurementPeriod?: string;
  internalApprovalRule?: string;
  roles: ManagementRoleAssignment[];
  weeklyChecklist: ManagementChecklistItem[];
  meetings: ManagementWeeklyMeeting[];
  weeklyPlans?: ManagementWeeklyPlanItem[];
}

export type WeeklyRoutineDiaryStatus = 'notFilled' | 'filled' | 'noProduction' | 'impediment';

export interface WeeklyRoutineChapterPathItem {
  id: string;
  name: string;
  number?: string;
}

/** Modelo somente de apresentação, derivado do Cronograma e dos Diários existentes. */
export interface WeeklyRoutineActivity {
  taskId: string;
  taskName: string;
  chapterName: string;
  chapterNumber?: string;
  chapterPath: WeeklyRoutineChapterPathItem[];
  date: string;
  startDate: string;
  endDate: string;
  plannedQuantity: number;
  actualQuantity: number;
  unit: string;
  teamCode?: TeamCode;
  responsible?: string;
  completed: boolean;
}

/** Um dia da agenda semanal; não é persistido no projeto. */
export interface WeeklyRoutineDay {
  date: string;
  diaryStatus: WeeklyRoutineDiaryStatus;
  activities: WeeklyRoutineActivity[];
}

export interface Project {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  phases: Phase[];
  totalBudget: number;
  /** Modelo 2: contrato-base imutavel e modulos alimentados pela mesma estrutura. */
  contractSchemaVersion?: 1 | 2;
  /** Versao da associacao central entre contrato, EAP e composicoes analiticas. */
  analyticLinkSchemaVersion?: 2;
  contractRevisions?: ContractRevision[];
  contractRectifications?: ContractRectification[];
  costLedger?: CostLedgerEntry[];
  /** Equipes do projeto. Quando undefined, usa-se DEFAULT_TEAMS. */
  teams?: TeamDefinition[];
  /** Cargos executivos usados para dimensionamento de equipes. Nao altera insumos originais. */
  operationalRoles?: OperationalRole[];
  /** Regras/correcoes de normalizacao de mao de obra para cargos executivos. */
  laborNormalizationRules?: LaborNormalizationRule[];
  /** Disponibilidade geral de mao de obra cadastrada para a obra. */
  laborAvailability?: LaborAvailability[];
  /** Parametros de jornada e arredondamento do dimensionamento de equipes. */
  laborDimensioningSettings?: LaborDimensioningSettings;
  /** Estado visual persistido da UI (ex.: capítulos minimizados na EAP). */
  uiState?: ProjectUiState;
  /** Dados contratuais usados no boletim de medição. */
  contractInfo?: ContractInfo;
  /** Medições geradas e salvas (snapshots). */
  measurements?: SavedMeasurement[];
  /** Rascunho de filtros da medição em preparação (datas, capítulo, busca). */
  measurementDraft?: MeasurementDraft;
  /** Estado visual persistido da Medição (capítulos colapsados por aba ativa). */
  measurementUiState?: MeasurementUiState;
  /** Diários de obra registrados, indexados por data. */
  dailyReports?: DailyReport[];
  /** Rotina gerencial da obra: papeis, checklist semanal, reunioes e pendencias. */
  managementRoutine?: ManagementRoutine;
  /** Aditivos contratuais importados (Sintética + Analítica). Isolado das demais áreas. */
  additives?: Additive[];
  /** Itens financeiros importados da planilha SINTÉTICA (fonte da Medição). */
  budgetItems?: BudgetItem[];
  /** BDI (%) lido da Sintética (J8). Quando presente, sobrepõe contractInfo.bdiPercent. */
  syntheticBdiPercent?: number;
  /** Carimbo de quando a Sintética foi importada. */
  syntheticImportedAt?: string;
  /** Trilha de auditoria (Aditivo, Medição, Diário etc.). */
  auditLogs?: AuditLog[];
  /** Comparativos de preços de materiais (Lista de Material). Isolado das demais áreas. */
  materialComparisons?: MaterialComparison[];
  /** Histórico consolidado de preços de materiais (todas as cotações fechadas). */
  materialPriceHistory?: PriceHistoryEntry[];
  /** Fornecedores globais do projeto (compartilhados entre comparativos). */
  materialSuppliers?: ComparisonSupplier[];
  /** Classificacao manual dos insumos da Lista de Material, indexada pelo linkKey do insumo. */
  materialCostClasses?: Record<string, MaterialCostClass>;
  /** Movimentações de estoque/almoxarifado por insumo. */
  stockMovements?: StockMovement[];
  /**
   * Composições analíticas do contrato/base (planilha Analítica).
   * Cada composição traz seus insumos (inputs) que alimentam a Lista de Material.
   * NÃO é usado em cálculos de Medição/Cronograma/Diário/Aditivo — somente para sugestão de compras.
   * Reusa AdditiveComposition para manter a mesma estrutura de insumos analíticos.
   */
  analyticCompositions?: AdditiveComposition[];
  /** Catálogo da obra para reutilizar estruturas técnicas de novos serviços aditivados. */
  additiveCompositionCatalog?: AdditiveCompositionTemplate[];
  /** Estado do módulo Almoxarifado (estoque, movimentações, equipamentos, termos). */
  warehouse?: WarehouseState;
}

// =================== ALMOXARIFADO ===================

export type WarehouseMovementType =
  | 'entrada'
  | 'devolucao'
  | 'retirada'
  | 'perda'
  | 'transferencia_saida'
  | 'transferencia_entrada'
  | 'ajuste_positivo'
  | 'ajuste_negativo'
  | 'estorno';

export interface WarehouseLocation {
  id: string;
  name: string;
  notes?: string;
}

export interface WarehouseItemConfig {
  /** linkKey (igual ao usado em materialComparisons). */
  key: string;
  code?: string;
  description: string;
  unit: string;
  /** Item criado diretamente no almoxarifado, sem alterar orçamento/lista de material. */
  manualItem?: boolean;
  minStock?: number;
  plannedQuantity?: number;
  purchasedQuantity?: number;
  unitPrice?: number;
  purchaseGroupId?: string;
  supplierId?: string;
  defaultLocationId?: string;
  /** Item oculto das operações correntes, preservado para histórico e auditoria. */
  archivedAt?: string;
  archivedReason?: 'fiscal_note_canceled' | 'manual_archive';
  /** Justificativa para material comprado que não estava previsto no orçamento. */
  unplannedReason?: string;
}

export interface WarehouseAttachment {
  id: string;
  name: string;
  /** dataURL embutido — APENAS legado/fallback offline; novos anexos vão para o Storage. */
  dataUrl?: string;
  /** Caminho no Storage do bucket `daily-report-photos` (`${projectId}/warehouse/...`). */
  storagePath?: string;
  /** MIME do arquivo, usado para abrir/baixar. */
  mimeType?: string;
  kind?: 'nf' | 'foto' | 'recibo' | 'termo' | 'outro';
  uploadedAt: string;
}

/** Identidade do usuário autenticado preservada no momento da operação. */
export interface WarehouseAuditActor {
  userId?: string;
  userName?: string;
  userEmail?: string;
}

export interface WarehouseMovement {
  id: string;
  type: WarehouseMovementType;
  /** ISO yyyy-mm-dd. */
  date: string;
  createdAt: string;
  updatedAt?: string;
  createdBy?: WarehouseAuditActor;
  updatedBy?: WarehouseAuditActor;
  itemKey: string;
  itemCode?: string;
  itemDescription: string;
  itemUnit: string;
  /** Quantidade absoluta (positiva). Sinal definido pelo type. */
  quantity: number;
  unitPrice?: number;
  locationId?: string;
  // origens
  purchaseOrderId?: string;
  supplierId?: string;
  fiscalNoteId?: string;
  /** Item da nota que originou a entrada, usado para reavaliacao de custos sem ambiguidade. */
  fiscalNoteItemId?: string;
  invoiceNumber?: string;
  // destinos
  requisitionId?: string;
  /** Capítulo principal da obra usado para consumo gerencial por frente/prédio. */
  chapterId?: string;
  taskId?: string;
  teamId?: string;
  workerName?: string;
  workFront?: string;
  // governança / rastreabilidade
  responsible?: string;
  user?: string;
  notes?: string;
  attachments?: WarehouseAttachment[];
  /** Movimento que este estorno reverte. */
  reversesId?: string;
  /** Movimento de estorno que reverteu este. */
  reversedById?: string;
  /** ID do diário em que foi publicado (quando aplicável). */
  publishedToDailyReportId?: string;
  /** Referência humana da devolução de sobra vinculada a uma retirada. */
  returnNumber?: string;
  /** Pessoa que entregou a sobra de volta ao almoxarifado. */
  returnerName?: string;
  /** Assinatura opcional de quem devolveu o material. */
  returnSignature?: string;
  /** Confirma que a sobra retornou apta para uso no almoxarifado. */
  returnCondition?: 'apto_estoque';
  /** Origem imutável da operação que gerou o movimento. */
  originType?: WarehouseMovementOriginType;
  originId?: string;
  inventorySessionId?: string;
  /** Custo unitário congelado no instante da saída/ajuste. */
  costSnapshot?: number;
}

export type WarehouseMovementOriginType =
  | 'fiscal_note'
  | 'withdrawal'
  | 'inventory'
  | 'return'
  | 'loss'
  | 'reversal'
  | 'legacy';

export type WarehouseFiscalNoteStatus =
  | 'em_processamento'
  | 'a_conferir'
  | 'aprovada'
  | 'rejeitada'
  | 'cancelada';

export type WarehouseFiscalDocumentType =
  | 'nfe'
  | 'nfce'
  | 'cupom_fiscal'
  | 'pedido_venda'
  | 'orcamento'
  | 'recibo'
  | 'outro';

export type WarehouseFiscalExtractionStatus = 'reading' | 'ready' | 'failed';
export type WarehouseFiscalArchiveReason = 'comprovante' | 'descartada' | 'lancamento_cancelado';

export type FiscalItemLinkStatus = 'vinculado' | 'pendente' | 'auto';

export type WarehouseFiscalCostReviewStatus =
  | 'not_required'
  | 'unknown_origin'
  | 'pending'
  | 'confirmed';

export interface WarehouseFiscalNoteItem {
  id: string;
  /** Codigo do produto na nota fiscal (coluna COD. PROD.). */
  productCode?: string;
  description: string;
  quantity: number;
  unit?: string;
  /** Quantidade efetivamente recebida no estoque apos conversao da unidade fiscal. */
  stockQuantity?: number;
  /** Unidade usada no estoque/orcamento. Quando ausente, usa a unidade da nota. */
  stockUnit?: string;
  /** Quantidade de estoque gerada por uma unidade fiscal: stockQuantity / quantity. */
  conversionFactor?: number;
  /** Valor unitario informado na nota fiscal, sem frete/ICMS extra. */
  unitPrice: number;
  /** Legado: frete extra alocado manualmente para este item. Novas notas usam WarehouseFiscalNote.freightAmount. */
  freightAmount?: number;
  /** Legado: ICMS/diferencial extra alocado manualmente para este item. Novas notas usam WarehouseFiscalNote.icmsAmount. */
  icmsAmount?: number;
  /** Valor total global do item, ja incluindo frete/ICMS extra quando houver. */
  globalTotalPrice?: number;
  totalPrice: number;
  category?: string;
  purchaseGroupId?: string;
  itemKey?: string;
  /** Status do vínculo com material do almoxarifado. */
  linkStatus?: FiscalItemLinkStatus;
  /** Origem da sugestão automática exibida na conferência. */
  linkSource?: 'codigo' | 'fornecedor' | 'descricao' | 'similaridade' | 'manual' | 'novo';
  linkConfidence?: number;
  /** Confiança da IA na leitura deste item (0-1). */
  confidence?: number;
}

export type FiscalInvoicePaymentStatus = 'aberta' | 'paga' | 'vencida' | 'cancelada';

export interface FiscalInvoiceEntry {
  id: string;
  /** Número da fatura/duplicata/parcela. */
  number?: string;
  /** Data de vencimento (YYYY-MM-DD). */
  dueDate?: string;
  /** Valor da parcela. */
  amount: number;
  /** Forma de pagamento (boleto, pix, cartão, etc). */
  paymentMethod?: string;
  status?: FiscalInvoicePaymentStatus;
  notes?: string;
}

export interface WarehouseFiscalNote {
  id: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: WarehouseAuditActor;
  updatedBy?: WarehouseAuditActor;
  supplierName?: string;
  supplierCnpj?: string;
  /** UF do emitente lida do documento ou confirmada manualmente. */
  supplierState?: string;
  /** Fotografia da UF da obra/destino no momento do lancamento. */
  destinationState?: string;
  invoiceNumber?: string;
  issueDate?: string;
  totalAmount: number;
  /** Frete total da compra, rateado proporcionalmente entre os itens. */
  freightAmount?: number;
  /** ICMS/diferencial total da compra, rateado proporcionalmente entre os itens. */
  icmsAmount?: number;
  /** Situacao da conferencia de frete e ICMS/DIFAL para compra interestadual. */
  costReviewStatus?: WarehouseFiscalCostReviewStatus;
  costReviewedAt?: string;
  costReviewedBy?: WarehouseAuditActor;
  status: WarehouseFiscalNoteStatus;
  origin: 'upload';
  sourceFileName: string;
  sourceMimeType?: string;
  /** Legado: primeiro anexo da nota. */
  attachment?: WarehouseAttachment;
  /** Um PDF ou até quatro fotografias/páginas. */
  attachments?: WarehouseAttachment[];
  items: WarehouseFiscalNoteItem[];
  /** Faturas / duplicatas / parcelas da nota. */
  invoices?: FiscalInvoiceEntry[];
  notes?: string;
  rejectionReason?: string;
  processingError?: string;
  extractedText?: string;
  documentType?: WarehouseFiscalDocumentType;
  documentTypeConfidence?: number;
  extractionStatus?: WarehouseFiscalExtractionStatus;
  extractionStartedAt?: string;
  extractionCompletedAt?: string;
  archiveReason?: WarehouseFiscalArchiveReason;
  archivedAt?: string;
  archivedBy?: string;
  stockPostedAt?: string;
  stockPostedBy?: string;
  canceledAt?: string;
  canceledBy?: string;
  cancellationReason?: string;
  /** Confiança média da IA na nota (0-1). */
  aiConfidence?: number;
  /** Justificativa preenchida quando soma dos itens difere do total. */
  totalsJustification?: string;
}

export interface WarehouseRequisitionItem {
  itemKey: string;
  code?: string;
  description: string;
  unit: string;
  quantity: number;
  /** Movimento de retirada gerado quando a requisição foi entregue. */
  movementId?: string;
  /** Custo médio congelado no momento da entrega. */
  unitCostSnapshot?: number;
}

export type WarehouseRequisitionStatus = 'rascunho' | 'entregue' | 'cancelada';

export interface WarehouseRequisition {
  id: string;
  number: string;
  date: string;
  status: WarehouseRequisitionStatus;
  taskId?: string;
  taskName?: string;
  chapterId?: string;
  chapterName?: string;
  teamId?: string;
  teamName?: string;
  requesterName?: string;
  receiverName?: string;
  workFront?: string;
  notes?: string;
  items: WarehouseRequisitionItem[];
  signatureWarehouse?: string; // dataURL PNG
  signatureReceiver?: string;
  warehouseOperator?: string;
  deliveryAttachments?: WarehouseAttachment[];
  deliveryIdempotencyKey?: string;
  /** Se true, foi espelhada no diário do dia. */
  publishedToDailyReportId?: string;
  createdAt: string;
  updatedAt?: string;
  createdBy?: WarehouseAuditActor;
  updatedBy?: WarehouseAuditActor;
}

export type EquipmentStatus = 'disponivel' | 'em_uso' | 'em_manutencao' | 'arquivado';
export type EquipmentExtractionStatus = 'idle' | 'reading' | 'ready' | 'failed';

export interface Equipment {
  id: string;
  name: string;
  description?: string;
  patrimony?: string;
  serial?: string;
  brand?: string;
  model?: string;
  category?: string;
  notes?: string;
  internalCode?: string;
  status?: EquipmentStatus;
  photos?: WarehouseAttachment[];
  extractionStatus?: EquipmentExtractionStatus;
  extractionError?: string;
  extractionConfidence?: Partial<Record<'brand' | 'model' | 'serial' | 'category' | 'description', number>>;
  createdAt: string;
  updatedAt?: string;
  createdBy?: WarehouseAuditActor;
  updatedBy?: WarehouseAuditActor;
  archivedAt?: string;
}

/** Agrupamento visual persistente de patrimônios, sem alterar cada equipamento. */
export interface WarehouseEquipmentGroup {
  id: string;
  name: string;
  equipmentIds: string[];
  createdAt: string;
  updatedAt?: string;
  createdBy?: WarehouseAuditActor;
  updatedBy?: WarehouseAuditActor;
}

export type CustodyEquipmentStatus =
  | 'em_uso'
  | 'devolvido'
  | 'divergencia'
  | 'perdido'
  | 'danificado';

export type CustodyTermStatus =
  | CustodyEquipmentStatus
  | 'parcial'
  | 'encerrado_com_ocorrencia';

export interface CustodyTermEquipmentItem {
  equipmentId: string;
  equipmentName: string;
  equipmentPatrimony?: string;
  equipmentInternalCode?: string;
  equipmentBrand?: string;
  equipmentModel?: string;
  equipmentSerial?: string;
  equipmentPhoto?: WarehouseAttachment;
  accessories?: string;
  stateOnDelivery?: string;
  status: CustodyEquipmentStatus;
  returnedAt?: string;
  stateOnReturn?: string;
  divergenceNotes?: string;
  returnAttachments?: WarehouseAttachment[];
}

export interface CustodyTerm {
  id: string;
  number: string;
  equipmentId: string;
  equipmentName: string;
  equipmentPatrimony?: string;
  equipmentInternalCode?: string;
  equipmentBrand?: string;
  equipmentModel?: string;
  equipmentSerial?: string;
  equipmentPhoto?: WarehouseAttachment;
  /** Estrutura atual. Campos singulares permanecem para leitura de termos legados. */
  equipments?: CustodyTermEquipmentItem[];
  issuedAt: string;
  dueDate?: string;
  workerName: string;
  chapterId?: string;
  chapterName?: string;
  teamId?: string;
  teamName?: string;
  accessories?: string;
  stateOnDelivery?: string;
  signatureWarehouse?: string;
  signatureReceiver?: string;
  status: CustodyTermStatus;
  returnedAt?: string;
  stateOnReturn?: string;
  divergenceNotes?: string;
  attachments?: WarehouseAttachment[];
  returnAttachments?: WarehouseAttachment[];
  createdAt: string;
  updatedAt?: string;
  createdBy?: WarehouseAuditActor;
  updatedBy?: WarehouseAuditActor;
}

export type WarehouseMaterialLinkSource = 'supplier_history' | 'exact_code' | 'description_unit' | 'similarity' | 'manual';

/** Vínculo confirmado entre o material físico canônico e um insumo previsto. */
export interface WarehouseProjectMaterialLink {
  id: string;
  warehouseItemKey: string;
  projectMaterialKey: string;
  projectMaterialCode?: string;
  projectMaterialDescription: string;
  projectMaterialUnit: string;
  conversionFactor: number;
  source: WarehouseMaterialLinkSource;
  confidence?: number;
  supplierCnpj?: string;
  supplierProductCode?: string;
  createdAt: string;
  updatedAt?: string;
  createdBy?: WarehouseAuditActor;
  updatedBy?: WarehouseAuditActor;
}

export type WarehouseInventorySessionStatus = 'em_contagem' | 'em_revisao' | 'aplicado' | 'cancelado';

export interface WarehouseInventoryLine {
  itemKey: string;
  itemCode?: string;
  itemDescription: string;
  itemUnit: string;
  countedQuantity?: number;
  expectedQuantity?: number;
  difference?: number;
  unitCostSnapshot?: number;
  movementId?: string;
}

export interface WarehouseInventorySession {
  id: string;
  number: string;
  month: string;
  status: WarehouseInventorySessionStatus;
  startedAt: string;
  closedAt?: string;
  appliedAt?: string;
  canceledAt?: string;
  justification?: string;
  lines: WarehouseInventoryLine[];
  createdBy?: WarehouseAuditActor;
  updatedBy?: WarehouseAuditActor;
}

export interface WarehouseState {
  locations: WarehouseLocation[];
  items: WarehouseItemConfig[];
  movements: WarehouseMovement[];
  requisitions: WarehouseRequisition[];
  equipments: Equipment[];
  equipmentGroups: WarehouseEquipmentGroup[];
  custodyTerms: CustodyTerm[];
  fiscalNotes?: WarehouseFiscalNote[];
  materialLinks?: WarehouseProjectMaterialLink[];
  inventorySessions?: WarehouseInventorySession[];
  valuationMethod?: 'weighted_average';
}

// =================== LISTA DE MATERIAL / COMPARATIVOS ===================

export type MaterialComparisonStatus = 'rascunho' | 'em_cotacao' | 'fechado' | 'comprado';
export type ComparisonItemStatus = 'pendente' | 'orcado' | 'pedido_parcial' | 'comprado';
export type MaterialCostClass = 'material' | 'labor' | 'equipment' | 'unclassified';

export interface ComparisonSupplier {
  id: string;
  name: string;
  contact?: string;
  /** Prazo de entrega em dias. */
  deliveryDays?: number;
  /** Avaliação 0-5. */
  rating?: number;
  notes?: string;
}

export interface ComparisonItemPrice {
  supplierId: string;
  /** Preço unitário cotado. */
  price: number;
  /** Total (price * quantity); recalculado quando salvar. */
  total: number;
  /** Disponível para entrega? */
  available?: boolean;
  notes?: string;
}

export interface ComparisonItemPurchase {
  id: string;
  supplierId: string;
  /** Quantidade confirmada neste pedido. */
  quantity: number;
  /** Preço unitário confirmado no momento do pedido. */
  unitPrice: number;
  /** ISO date. */
  confirmedAt: string;
}

export interface ComparisonItem {
  id: string;
  code?: string;
  description: string;
  unit: string;
  /** Quantidade liberada para compra = saldo contratado + acréscimos formalizados. */
  quantity: number;
  /** Saldo do contrato-base após todas as supressões ativas; não inclui acréscimos. */
  contractedQuantity?: number;
  /** Soma dos acréscimos ativos, pendentes ou formalizados; nunca é negativa. */
  additiveQuantity?: number;
  /** Quantidade projetada = saldo contratado + todos os acréscimos ativos. */
  totalQuantity?: number;
  /** Quantidade segura para compra = saldo contratado + acréscimos formalizados. */
  purchasableQuantity?: number;
  /** Preço de referência (orçamento/SINAPI/anterior). */
  referencePrice?: number;
  /** Fornecedor escolhido manualmente; quando ausente, usa-se o menor preço. */
  chosenSupplierId?: string;
  prices: ComparisonItemPrice[];
  /** Confirmações de pedido, permitindo compra parcial e histórico por fornecedor. */
  purchaseOrders?: ComparisonItemPurchase[];
  status?: ComparisonItemStatus;
  /** Origem (insumo analítico, material de tarefa, insumo de aditivo, manual). */
  sourceType?: 'manual' | 'task_material' | 'analytic_input' | 'additive_input';
  /** Subtipo da origem quando vem do Aditivo. */
  sourceDetail?: 'contracted_item' | 'additive_new_service' | 'additive_existing_changed';
  sourceId?: string;
  /** Motivo de arquivamento operacional; o item permanece apenas para histórico e estoque. */
  archivedReason?: 'fully_suppressed';
  /** Data ISO em que o item foi retirado dos fluxos ativos de compra. */
  archivedAt?: string;
  /** Grupo de compra livre (ex.: "PVC CONEXÕES", "CABEAMENTO"). */
  purchaseGroup?: string;
}

export interface PriceHistoryEntry {
  id: string;
  itemCode?: string;
  itemDescription: string;
  unit: string;
  supplierId?: string;
  supplierName: string;
  price: number;
  /** ISO date. */
  date: string;
  comparisonId: string;
  comparisonName: string;
}

export interface MaterialComparison {
  id: string;
  name: string;
  status: MaterialComparisonStatus;
  description?: string;
  suppliers: ComparisonSupplier[];
  /** IDs de fornecedores globais participantes deste comparativo. */
  supplierIds?: string[];
  items: ComparisonItem[];
  /** ISO. */
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

// =================== ESTOQUE / ALMOXARIFADO ===================

export type StockMovementType = 'entrada' | 'saida' | 'ajuste';

export interface StockMovement {
  id: string;
  /** ISO yyyy-mm-dd (ou ISO completo). */
  date: string;
  /** Chave estável do insumo (linkKeyOf). */
  itemKey: string;
  /** Snapshot descritivo para exibição mesmo se o insumo sumir. */
  itemCode?: string;
  itemDescription: string;
  itemUnit: string;
  type: StockMovementType;
  /** Quantidade (positiva). Sinal definido pelo `type`. */
  quantity: number;
  /** Fornecedor global (id) — usado em entradas. */
  supplierId?: string;
  /** Tarefa/composição vinculada — usado em saídas. */
  taskId?: string;
  notes?: string;
  /** Usuário responsável (livre). */
  user?: string;
  createdAt: string;
}

/** Origem do item financeiro (Sintética importada ou Aditivo aprovado). */
export type BudgetItemSource = 'sintetica' | 'aditivo';

/** Item financeiro do orçamento — usado pela aba Medição. */
export interface BudgetItem {
  id: string;
  /** Item da planilha (ex.: "1.1.1"). */
  item: string;
  /** Código (ex.: SINAPI). */
  code: string;
  /** Banco (ex.: SINAPI, SBC, próprio). */
  bank: string;
  description: string;
  unit: string;
  quantity: number;
  unitPriceNoBDI: number;
  unitPriceWithBDI: number;
  totalNoBDI: number;
  totalWithBDI: number;
  source: BudgetItemSource;
  chapterCode?: string;
  chapterName?: string;
  subchapterCode?: string;
  subchapterName?: string;
  /** Vínculo opcional com tarefa (quando casado por código). */
  taskId?: string;
  /** Quando vier de aditivo aprovado, referência ao additive. */
  additiveId?: string;
  /** Chave natural usada somente para importacao e reconciliacao. */
  canonicalKey?: string;
  /** Valores crus preservados para auditoria da planilha. */
  sourceValues?: {
    quantity: string;
    unitPriceNoBDI: string;
    totalNoBDI: string;
    unitPriceWithBDI: string;
    totalWithBDI: string;
  };
  /** Fotografia imutavel do item no contrato-base. */
  baseContract?: {
    quantity: number;
    unitPriceNoBDI: number;
    unitPriceWithBDI: number;
    totalNoBDI: number;
    totalWithBDI: number;
  };
  currentRevisionId?: string;
}

// =================== ADITIVO ===================

/** Mantido apenas por compatibilidade com aditivos antigos. UI não usa mais. */
export type AdditiveInputType = 'material' | 'mao_obra' | 'equipamento' | 'outro';

export interface AdditiveInput {
  id: string;
  code: string;
  bank: string;
  description: string;
  /** @deprecated não usado mais na UI; mantido para retro-compatibilidade. */
  type?: AdditiveInputType;
  unit: string;
  coefficient: number;
  unitPrice: number;
  total: number;
}

/** Classificação contratual da composição do aditivo. */
export type AdditiveChangeKind = 'acrescido' | 'suprimido' | 'sem_alteracao';

/** Origem dos valores da composição do aditivo. */
export type AdditiveCompositionSource = 'sintetica_medicao' | 'excel_aditivo' | 'manual';

export interface AdditiveComposition {
  id: string;
  item: string;
  code: string;
  bank: string;
  description: string;
  /** Quantidade lida da Sintética (proposta no aditivo). */
  quantity: number;
  unit: string;
  unitPriceNoBDI: number;
  unitPriceWithBDI: number;
  total: number;
  /** Totais preservados quando a composição vem de uma fonte já calculada (Sintética da Medição). */
  totalNoBDI?: number;
  totalWithBDI?: number;
  inputs: AdditiveInput[];
  /** Item financeiro imutavel do contrato-base que originou esta linha. */
  baseBudgetItemId?: string;
  /** Composicao Analitica imutavel do contrato-base herdada por esta linha. */
  baseAnalyticCompositionId?: string;
  /** Tarefa original da EAP contratual. */
  baseTaskId?: string;
  /** Valor unitário c/ BDI lido da linha "Valor com BDI =" da Analítica (por unidade da composição). */
  analyticUnitPriceWithBDI?: number;
  /** Valor unitário de referência s/ BDI lido na linha pai "Composição" da Analítica. */
  analyticReferenceUnitPriceNoBDI?: number;
  /** Total c/ BDI calculado a partir da Analítica (= analyticUnitPriceWithBDI * quantity). */
  analyticTotalWithBDI?: number;
  /** Origem dos valores financeiros, usada para preservar totais já calculados pela Sintética da Medição. */
  source?: AdditiveCompositionSource;
  // ----- Estrutura contratual (modelo "1ºADITIVO") -----
  /** Tipo de alteração: acrescido (padrão), suprimido ou sem alteração. */
  changeKind?: AdditiveChangeKind;
  /** Quantidade originalmente contratada (referência). */
  originalQuantity?: number;
  /** Quantidade suprimida pelo aditivo. */
  suppressedQuantity?: number;
  /** Quantidade acrescida pelo aditivo. */
  addedQuantity?: number;
  // ----- Vínculo com a EAP/Medição (preenchido quando criado via "Usar Sintética da Medição") -----
  /** Phase (capítulo) da EAP a que esta composição pertence. */
  phaseId?: string;
  /** Cadeia "Capítulo › Subcapítulo". */
  phaseChain?: string;
  /** Tarefa da EAP vinculada. */
  taskId?: string;
  /** Numeração hierárquica da EAP (ex.: "1.1.3"). */
  itemNumber?: string;
  // ----- Novos serviços em estudo (criados manualmente no Aditivo) -----
  /** Quando true, é um novo serviço ainda em estudo no Aditivo (não integra Medição/EAP/Cronograma até "Aditivo Contratado"). */
  isNewService?: boolean;
  /** Valor unitário s/ BDI informado pelo usuário (antes do desconto global). Apenas para novos serviços. */
  unitPriceNoBDIInformed?: number;
  /** Memória de cálculo justificando as quantidades suprimidas/acrescidas. */
  calculationMemory?: AdditiveCalculationMemoryRow[];
  /** Nomes personalizados das colunas dimensionais da memória de cálculo (por composição). */
  calculationMemoryColumns?: AdditiveCalculationMemoryColumns;
  /** Tarefa criada/atualizada quando o aditivo foi integrado ao projeto. */
  linkedTaskId?: string;
  /** Carimbo de quando esta composição foi integrada ao projeto. */
  integratedAt?: string;
}

/** Estrutura técnica reutilizável de um novo serviço, sem quantidades ou memória de cálculo. */
export interface AdditiveCompositionTemplate {
  id: string;
  code: string;
  normalizedCode: string;
  bank: string;
  description: string;
  unit: string;
  unitPriceNoBDIInformed?: number;
  analyticReferenceUnitPriceNoBDI?: number;
  inputs: AdditiveInput[];
  sourceAdditiveId?: string;
  updatedAt: string;
}

/** Linha da memória de cálculo (Arquimedes-like) de uma composição do aditivo. */
export interface AdditiveCalculationMemoryRow {
  id: string;
  /** Tipo: acrescida soma na Qtd Acrescida; suprimida soma na Qtd Suprimida. */
  type: 'acrescida' | 'suprimida';
  /** Local/frente/ambiente. (Legado — hoje "Loc" é número automático derivado da posição.) */
  loc?: string;
  /** Comentário livre (justificativa do item). */
  comment?: string;
  /** Fórmula opcional usando A,B,C,D. Vazio = A*B*C*D. */
  formula?: string;
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  /** Resultado calculado (cache). */
  partial: number;
}

/** Nomes personalizados das colunas dimensionais (A,B,C,D) por composição. */
export interface AdditiveCalculationMemoryColumns {
  a?: string;
  b?: string;
  c?: string;
  d?: string;
}

/** Rótulos padrão das colunas dimensionais da memória de cálculo. */
export const DEFAULT_MEMORY_COLUMN_LABELS: Required<AdditiveCalculationMemoryColumns> = {
  a: 'UND',
  b: 'Comprim.',
  c: 'Largura',
  d: 'Altura',
};

export interface AdditiveImportIssue {
  level: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  line?: number;
}

/** Estados do fluxo de aprovação do aditivo. */
export type AdditiveStatus =
  | 'rascunho'
  | 'em_analise'
  | 'aprovado'
  | 'contratado'
  | 'rejeitado'
  | 'cancelado'
  // valores legados preservados somente para leitura
  | 'reprovado'
  | 'aditivo_contratado';

/** Regra usada para formar o preço de novos serviços do aditivo. */
export type AdditivePricingRule =
  | 'legacy_discount_then_bdi_v1'
  | 'administration_bdi_then_discount_v1';

/** Snapshot congelado do aditivo no momento da aprovação (versionado). */
export interface AdditiveApprovalSnapshot {
  version: number;
  approvedAt: string;
  approvedBy?: string;
  reviewNotes?: string;
  bdiPercent: number;
  globalDiscountPercent: number;
  pricingRuleVersion?: AdditivePricingRule;
  /** Totais agregados calculados na aprovação (estrutura aberta). */
  totals: unknown;
  compositions: AdditiveComposition[];
  issues: AdditiveImportIssue[];
}

export type AdditiveScheduleClassification =
  | 'contracted_released'
  | 'contracted_suspended'
  | 'proposed_addition'
  | 'proposed_suppression';

export type AdditiveScheduleState = 'scheduled' | 'suspended' | 'fully_suppressed';
export type AdditiveScheduleFinancialTreatment = 'monthly' | 'total_only' | 'excluded';
export type AdditiveScheduleRestrictionKind = 'contracted_balance_only';

export interface AdditiveScheduleQuantityRestriction {
  kind: AdditiveScheduleRestrictionKind;
  contractedQuantity: number;
  executableQuantity: number;
  addedQuantity: number;
  suppressedQuantity: number;
  unit?: string;
}

export interface AdditiveScheduleBlockingCompositionRef {
  compositionId: string;
  item?: string;
  code?: string;
  description: string;
  quantity: number;
  unit?: string;
}

/** Planejamento isolado de uma tarefa contratada no Cronograma do Aditivo. */
export interface AdditiveScheduleContractedTaskPlan {
  taskId: string;
  startDate: string;
  duration: number;
  dependencies: string[];
  dependencyDetails?: TaskDependency[];
  responsible: string;
  team?: TeamCode;
  scheduleOrder?: number;
  durationMode?: 'manual' | 'rup';
  isManual?: boolean;
  manualDuration?: number;
}

/** Relação documental entre uma tarefa suspensa e as composições que a bloqueiam. */
export interface AdditiveScheduleDependencyBlock {
  taskId: string;
  compositionIds: string[];
  note?: string;
}

/** Programação preliminar de um serviço novo, ainda isolada do contrato vigente. */
export interface AdditiveSchedulePlannedTask {
  compositionId: string;
  taskId: string;
  phaseId: string;
  name: string;
  startDate: string;
  duration: number;
  dependencies: string[];
  dependencyDetails?: TaskDependency[];
  responsible: string;
  team?: TeamCode;
  scheduleOrder?: number;
  durationMode?: 'manual' | 'rup';
  isManual?: boolean;
  manualDuration?: number;
  /** Exige uma decisão consciente sobre data/duração antes da contratação. */
  datesConfirmed?: boolean;
}

/** Rascunho editável do cronograma associado a uma versão do aditivo. */
export interface AdditiveScheduleDraft {
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Tarefas contratadas que dependem tecnicamente do aditivo. */
  dependentTaskIds: string[];
  /** Somente serviços novos ficam aqui; tarefas contratadas permanecem em Project.phases. */
  plannedTasks: AdditiveSchedulePlannedTask[];
  /** Sobrescritas esparsas das tarefas contratadas planejadas neste aditivo. */
  contractedTaskPlans?: AdditiveScheduleContractedTaskPlan[];
  /** Composições que justificam cada suspensão manual. */
  dependencyBlocks?: AdditiveScheduleDependencyBlock[];
}

/** Linha congelada usada na leitura histórica e nas exportações da prévia formalizada. */
export interface AdditiveScheduleSnapshotRow {
  taskId: string;
  compositionId?: string;
  phaseId: string;
  phaseName: string;
  item?: string;
  code?: string;
  description: string;
  classification: AdditiveScheduleClassification;
  statusLabel: string;
  /** Optional for backwards compatibility; legacy rows are inferred at runtime. */
  scheduleState?: AdditiveScheduleState;
  /** Controls monthly allocation without changing the contractual value. */
  financialTreatment?: AdditiveScheduleFinancialTreatment;
  /** Quantidades congeladas para distinguir execução contratada de impactos pendentes. */
  quantityRestriction?: AdditiveScheduleQuantityRestriction;
  /** Referências congeladas das composições que bloquearam a tarefa. */
  blockingCompositions?: AdditiveScheduleBlockingCompositionRef[];
  blockingNote?: string;
  /** Causas congeladas quando a suspensão foi herdada de predecessoras sem autorização. */
  dependencyBlockingTaskIds?: string[];
  suspensionReason?: string;
  startDate: string;
  duration: number;
  dependencies: string[];
  dependencyDetails?: TaskDependency[];
  responsible: string;
  team?: TeamCode;
  scheduleOrder?: number;
  durationMode?: 'manual' | 'rup';
  isManual?: boolean;
  manualDuration?: number;
  quantity: number;
  unit?: string;
  unitPriceWithBDI: number;
  totalWithBDI: number;
}

/** Estrutura hierarquica congelada para reproduzir o Gantt arquivado. */
export interface AdditiveScheduleSnapshotPhase {
  id: string;
  name: string;
  parentId?: string;
  order?: number;
  customNumber?: string;
}

export interface AdditiveScheduleSnapshot {
  id: string;
  version: number;
  archivedAt: string;
  archivedBy?: string;
  contractRevisionId?: string;
  referenceDocument: string;
  /** Optional for backwards compatibility with snapshots created before hierarchy export. */
  phases?: AdditiveScheduleSnapshotPhase[];
  rows: AdditiveScheduleSnapshotRow[];
}

export interface Additive {
  id: string;
  name: string;
  importedAt: string;
  compositions: AdditiveComposition[];
  issues?: AdditiveImportIssue[];
  /** BDI (%) editável. Quando importado, vem da célula J8 da Sintética. */
  bdiPercent?: number;
  // ----- Fluxo de aprovação -----
  status?: AdditiveStatus;
  approvedAt?: string;
  approvedBy?: string;
  reviewNotes?: string;
  /** Limite de aditivo da licitação em % (padrão 50%). Usado para indicar status OK/Revisar. */
  aditivoLimitPercent?: number;
  /** Desconto global da licitação (%). Aplicado APENAS aos novos serviços (isNewService). */
  globalDiscountPercent?: number;
  /**
   * Versão da regra financeira. A ausência em aditivo já contratado identifica
   * o cálculo legado; rascunhos e revisões abertas usam a regra da Administração.
   */
  pricingRuleVersion?: AdditivePricingRule;
  /** True quando o usuário clicou em "Aditivo Contratado" — integra novos serviços ao projeto. */
  isContracted?: boolean;
  /** Carimbo de quando o aditivo foi marcado como contratado. */
  contractedAt?: string;
  /** Data a partir da qual a revisao passa a compor o contrato vigente. */
  effectiveDate?: string;
  contractRevisionId?: string;
  /**
   * Libera revisao de um aditivo ja integrado. Enquanto true, a tela volta a aceitar
   * acrescimos, supressoes, novos servicos e exclusoes; a nova versao so afeta as
   * abas vinculadas quando o usuario clicar em reintegrar.
   */
  editUnlocked?: boolean;
  /** Carimbo da liberacao de revisao apos integracao. */
  editUnlockedAt?: string;
  /** Usuario/responsavel que liberou revisao apos integracao. */
  editUnlockedBy?: string;
  /** Versão atual do aditivo (incrementa a cada aprovação). */
  version?: number;
  /** Histórico de snapshots aprovados (congelados). */
  approvalSnapshots?: AdditiveApprovalSnapshot[];
  /** Estado visual persistido por aditivo (capítulos recolhidos, composições abertas, mostrar analítico). */
  uiState?: AdditiveUiState;
  /** Subcapítulos criados manualmente neste aditivo, inclusive enquanto ainda não têm serviços. */
  visiblePhaseIds?: string[];
  /** Data de emissão do relatório (override do cabeçalho exportado). ISO. */
  headerIssueDate?: string;
  /** Responsável exibido no cabeçalho exportado (sobrepõe approvedBy). */
  headerResponsible?: string;
  /** Cronograma preliminar editável, sem efeitos na execução enquanto o aditivo não for contratado. */
  scheduleDraft?: AdditiveScheduleDraft;
  /** Versões congeladas do cronograma que subsidiou cada contratação/reintegração. */
  scheduleSnapshots?: AdditiveScheduleSnapshot[];
}

export interface AdditiveUiState {
  /** IDs (phaseId) de capítulos/subcapítulos recolhidos na tabela do Aditivo. */
  collapsedGroupIds?: string[];
  /** IDs de capítulos/subcapítulos recolhidos somente no Cronograma do Aditivo. */
  scheduleCollapsedPhaseIds?: string[];
  /** IDs de composições com painel analítico expandido. */
  expandedCompositionIds?: string[];
  /** IDs de composições com painel de memória de cálculo expandido. */
  expandedMemoryIds?: string[];
  /** Mostrar/ocultar painel analítico globalmente. */
  showAnalytic?: boolean;
}

// =================== AUDITORIA ===================

export type AuditEntityType =
  | 'measurement'
  | 'additive'
  | 'daily_report'
  | 'task'
  | 'warehouse_fiscal_note'
  | 'project';

export type AuditAction =
  | 'created'
  | 'updated'
  | 'submitted_for_review'
  | 'approved'
  | 'rejected'
  | 'contracted'
  | 'unlocked'
  | 'deleted'
  | 'imported'
  | 'exported';

export interface AuditLog {
  id: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  title: string;
  description?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  /** ISO timestamp. */
  at: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export type ViewMode = 'days' | 'weeks' | 'months';
export type AppView = 'dashboard' | 'management' | 'gantt' | 'tasks' | 'measurement' | 'dailyReport' | 'additive' | 'additiveSchedule' | 'realCost' | 'materials' | 'warehouse';
