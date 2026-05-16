export interface LaborComposition {
  id: string;
  role: string; // e.g. "Encanador", "Ajudante"
  rup: number; // hours per unit (h/un)
  workerCount: number;
  hourlyRate?: number;
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
  kind?: 'novo' | 'acrescimo' | 'supressao';
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
  /** Nº da ART (Anotação de Responsabilidade Técnica). */
  artNumber?: string;
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
  /** ISO yyyy-mm-dd — chave por data. */
  date: string;
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

export interface Project {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  phases: Phase[];
  totalBudget: number;
  /** Equipes do projeto. Quando undefined, usa-se DEFAULT_TEAMS. */
  teams?: TeamDefinition[];
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
}

// =================== LISTA DE MATERIAL / COMPARATIVOS ===================

export type MaterialComparisonStatus = 'rascunho' | 'em_cotacao' | 'fechado' | 'comprado';
export type ComparisonItemStatus = 'pendente' | 'orcado' | 'comprado';

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

export interface ComparisonItem {
  id: string;
  code?: string;
  description: string;
  unit: string;
  quantity: number;
  /** Preço de referência (orçamento/SINAPI/anterior). */
  referencePrice?: number;
  /** Fornecedor escolhido manualmente; quando ausente, usa-se o menor preço. */
  chosenSupplierId?: string;
  prices: ComparisonItemPrice[];
  status?: ComparisonItemStatus;
  /** Origem (insumo analítico, material de tarefa, insumo de aditivo, manual). */
  sourceType?: 'manual' | 'task_material' | 'analytic_input' | 'additive_input';
  sourceId?: string;
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
  items: ComparisonItem[];
  /** ISO. */
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
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
  /** Vínculo opcional com tarefa (quando casado por código). */
  taskId?: string;
  /** Quando vier de aditivo aprovado, referência ao additive. */
  additiveId?: string;
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
  /** Valor unitário c/ BDI lido da linha "Valor com BDI =" da Analítica (por unidade da composição). */
  analyticUnitPriceWithBDI?: number;
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
export type AdditiveStatus = 'rascunho' | 'em_analise' | 'reprovado' | 'aprovado' | 'aditivo_contratado';

/** Snapshot congelado do aditivo no momento da aprovação (versionado). */
export interface AdditiveApprovalSnapshot {
  version: number;
  approvedAt: string;
  approvedBy?: string;
  reviewNotes?: string;
  bdiPercent: number;
  globalDiscountPercent: number;
  /** Totais agregados calculados na aprovação (estrutura aberta). */
  totals: unknown;
  compositions: AdditiveComposition[];
  issues: AdditiveImportIssue[];
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
  /** True quando o usuário clicou em "Aditivo Contratado" — integra novos serviços ao projeto. */
  isContracted?: boolean;
  /** Carimbo de quando o aditivo foi marcado como contratado. */
  contractedAt?: string;
  /** Versão atual do aditivo (incrementa a cada aprovação). */
  version?: number;
  /** Histórico de snapshots aprovados (congelados). */
  approvalSnapshots?: AdditiveApprovalSnapshot[];
  /** Estado visual persistido por aditivo (capítulos recolhidos, composições abertas, mostrar analítico). */
  uiState?: AdditiveUiState;
  /** Data de emissão do relatório (override do cabeçalho exportado). ISO. */
  headerIssueDate?: string;
  /** Responsável exibido no cabeçalho exportado (sobrepõe approvedBy). */
  headerResponsible?: string;
}

export interface AdditiveUiState {
  /** IDs (phaseId) de capítulos/subcapítulos recolhidos na tabela do Aditivo. */
  collapsedGroupIds?: string[];
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
export type AppView = 'dashboard' | 'gantt' | 'tasks' | 'measurement' | 'dailyReport' | 'additive' | 'materials';
