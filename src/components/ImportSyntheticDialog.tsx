import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Project, BudgetItem, AdditiveComposition, AdditiveInputType, LaborComposition, MaterialCostClass, Phase, Task } from '@/types/project';
import {
  DEFAULT_SYNTHETIC_COLUMN_MAP,
  inspectSyntheticWorkbook,
  parseSyntheticBudgetFlexible,
  ParsedSynthetic,
  SyntheticColumnRole,
  SyntheticWorkbookPreview,
} from '@/lib/importParser';
import {
  extractBaseAnalyticCompositions,
  extractBaseAnalyticCompositionsFromAnalyticFile,
  priceNewContractFromAnalytic,
  DEFAULT_ANALYTIC_COLUMN_MAP,
  inspectAnalyticWorkbook,
  AnalyticColumnRole,
  AnalyticWorkbookPreview,
} from '@/lib/additiveImport';
import {
  FileSpreadsheet, AlertTriangle, Loader2, Check, Info, DollarSign, Layers,
  ClipboardCheck, FileText,
} from 'lucide-react';
import { guessMaterialCostClass, linkKeyOf, MATERIAL_COST_CLASS_LABEL } from '@/lib/materialComparisons';
import { calculateRupDuration } from '@/lib/calculations';
import { findMissingAnalyticItems, validateNewWorkImport } from '@/lib/newWorkImportValidation';

interface Props {
  open: boolean;
  onClose: () => void;
  project: Project;
  onProjectChange: (project: Project) => void;
  mode?: 'update' | 'create';
  existingProjectNames?: string[];
  onCreateProject?: (project: Project) => void | Promise<void>;
}

const fmtBRL = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const normalizeProjectName = (value: string) =>
  value.trim().replace(/\s+/g, ' ');

const comparableProjectName = (value: string) =>
  normalizeProjectName(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const COLUMN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

const ROLE_LABELS: Record<SyntheticColumnRole, string> = {
  ignore: 'Ignorar',
  item: 'Item',
  code: 'Codigo',
  bank: 'Banco',
  description: 'Descricao',
  quantity: 'Quantidade',
  unit: 'Unidade',
  unitPriceNoBDI: 'Valor unitario',
  totalNoBDI: 'Total sem BDI',
  unitPriceWithBDI: 'Valor unitario com BDI',
  totalWithBDI: 'Total',
};

const DEFAULT_COLUMN_ROLES: SyntheticColumnRole[] = [
  'item',
  'code',
  'bank',
  'description',
  'quantity',
  'unit',
  'unitPriceNoBDI',
  'totalNoBDI',
  'unitPriceWithBDI',
  'totalWithBDI',
];

const ANALYTIC_COLUMN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const PHASE_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--info))',
  'hsl(var(--warning))',
  'hsl(var(--success))',
  'hsl(var(--destructive))',
  'hsl(210, 60%, 50%)',
  'hsl(280, 50%, 55%)',
  'hsl(160, 50%, 45%)',
];

const ANALYTIC_ROLE_LABELS: Record<AnalyticColumnRole, string> = {
  ignore: 'Ignorar',
  kindOrItem: 'Tipo / Item',
  code: 'Codigo',
  bank: 'Banco',
  description: 'Descricao',
  coefficient: 'Coeficiente / Quant.',
  unit: 'Unidade',
  unitPrice: 'Valor unitario',
  total: 'Total',
};

const COST_CLASS_OPTIONS: MaterialCostClass[] = ['labor', 'material', 'equipment', 'unclassified'];

interface ContractDraft {
  projectName: string;
  contractor: string;
  contracted: string;
  location: string;
  contractObject: string;
  contractNumber: string;
  artNumber: string;
  budgetSource: string;
  bdiPercent: string;
  biddingDiscountPercent: string;
}

const DEFAULT_ANALYTIC_COLUMN_ROLES: AnalyticColumnRole[] = [
  'kindOrItem',
  'code',
  'bank',
  'description',
  'coefficient',
  'unit',
  'unitPrice',
  'total',
];

function normalizeHeaderLabel(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s/%.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectSyntheticColumnRoles(rows: string[][], headerRowIndex: number): SyntheticColumnRole[] {
  const roles = [...DEFAULT_COLUMN_ROLES];
  const header = rows[headerRowIndex] || [];
  const detected = new Array(COLUMN_LETTERS.length).fill('ignore') as SyntheticColumnRole[];
  let hits = 0;

  header.slice(0, COLUMN_LETTERS.length).forEach((raw, index) => {
    const label = normalizeHeaderLabel(raw);
    let role: SyntheticColumnRole = 'ignore';
    if (/^item$|^it$|ordem|indice/.test(label)) role = 'item';
    else if (/codigo|cod\.?|composicao|referencia/.test(label)) role = 'code';
    else if (/banco|base|fonte|origem/.test(label)) role = 'bank';
    else if (/descricao|descri|discriminacao|servico|atividade/.test(label)) role = 'description';
    else if (/quant|qtd|qtde|quantidade/.test(label)) role = 'quantity';
    else if (/^un$|und|unid|unidade/.test(label)) role = 'unit';
    else if (/total/.test(label) && /bdi/.test(label) && !/unit/.test(label)) role = 'totalWithBDI';
    else if (/total/.test(label) && !/unit/.test(label)) role = 'totalWithBDI';
    else if (/valor|preco|unit/.test(label)) {
      role = /bdi/.test(label) ? 'unitPriceWithBDI' : 'unitPriceNoBDI';
    }
    if (role !== 'ignore') hits++;
    detected[index] = role;
  });

  if (hits < 4) return roles;

  // Layout padrão dos orçamentos licitatórios A..J: a coluna H pode vir
  // sem rótulo próprio, mas é o total sem BDI entre G (unitário sem BDI) e
  // I/J (valores com BDI). Não a deixe ser ignorada.
  if (
    detected[6] === 'unitPriceNoBDI'
    && detected[7] === 'ignore'
    && detected[8] === 'unitPriceWithBDI'
    && detected[9] === 'totalWithBDI'
  ) {
    detected[7] = 'totalNoBDI';
  }
  return detected;
}

function detectAnalyticColumnRoles(rows: string[][], headerRowIndex: number, hasHeaderRow: boolean): AnalyticColumnRole[] {
  const roles = [...DEFAULT_ANALYTIC_COLUMN_ROLES];
  if (!hasHeaderRow) return roles;
  const header = rows[headerRowIndex] || [];
  const detected = new Array(ANALYTIC_COLUMN_LETTERS.length).fill('ignore') as AnalyticColumnRole[];
  let hits = 0;

  header.slice(0, ANALYTIC_COLUMN_LETTERS.length).forEach((raw, index) => {
    const label = normalizeHeaderLabel(raw);
    let role: AnalyticColumnRole = 'ignore';
    if (/^item$|tipo|classe|grupo/.test(label)) role = 'kindOrItem';
    else if (/codigo|cod\.?|composicao|insumo|referencia/.test(label)) role = 'code';
    else if (/banco|base|fonte|origem/.test(label)) role = 'bank';
    else if (/descricao|descri|discriminacao|insumo|servico|atividade/.test(label)) role = 'description';
    else if (/coef|quant|qtd|qtde|consumo|indice/.test(label)) role = 'coefficient';
    else if (/^un$|und|unid|unidade/.test(label)) role = 'unit';
    else if (/total|subtotal/.test(label)) role = 'total';
    else if (/valor|preco|unit/.test(label)) role = 'unitPrice';
    if (role !== 'ignore') hits++;
    detected[index] = role;
  });

  return hits >= 4 ? detected : roles;
}

function rolesToMap(roles: SyntheticColumnRole[]) {
  const map = { ...DEFAULT_SYNTHETIC_COLUMN_MAP };
  Object.keys(map).forEach(key => delete map[key as keyof typeof map]);
  roles.forEach((role, index) => {
    if (role !== 'ignore') map[role] = index;
  });
  return map;
}

function analyticRolesToMap(roles: AnalyticColumnRole[]) {
  const map = { ...DEFAULT_ANALYTIC_COLUMN_MAP };
  Object.keys(map).forEach(key => delete map[key as keyof typeof map]);
  roles.forEach((role, index) => {
    if (role !== 'ignore') map[role] = index;
  });
  return map;
}

function parseBdiInput(value: string): number | undefined {
  const raw = value.replace('%', '').trim();
  const normalized = raw.includes(',') && raw.includes('.')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(',', '.');
  if (!normalized) return undefined;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeCostUnit(value?: string) {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function inputTypeFromClass(costClass: MaterialCostClass): AdditiveInputType {
  if (costClass === 'labor') return 'mao_obra';
  if (costClass === 'equipment') return 'equipamento';
  if (costClass === 'material') return 'material';
  return 'outro';
}

function guessAnalyticInputClass(input: { description: string; unit?: string; type?: AdditiveInputType }): MaterialCostClass {
  const guessed = guessMaterialCostClass({
    description: input.description,
    unit: input.unit,
    sourceType: 'analytic_input',
    legacyInputType: input.type,
  });
  if (guessed !== 'unclassified') return guessed;

  const unit = normalizeCostUnit(input.unit);
  if (['h', 'hora', 'horas', 'mes', 'meses'].includes(unit)) return 'labor';
  return 'unclassified';
}

function classifyAnalyticCompositions(compositions: AdditiveComposition[]) {
  return compositions.map(composition => ({
    ...composition,
    inputs: (composition.inputs ?? []).map(input => {
      const costClass = guessAnalyticInputClass(input);
      return { ...input, type: inputTypeFromClass(costClass) };
    }),
  }));
}

function mergeAnalyticCostClasses(project: Project, compositions: AdditiveComposition[]) {
  const next: Record<string, MaterialCostClass> = { ...(project.materialCostClasses ?? {}) };
  for (const composition of compositions) {
    for (const input of composition.inputs ?? []) {
      const costClass = guessAnalyticInputClass(input);
      const byId = linkKeyOf({
        sourceId: input.id,
        code: input.code,
        description: input.description,
        unit: input.unit,
      });
      const byKey = linkKeyOf({
        code: input.code,
        description: input.description,
        unit: input.unit,
      });
      next[byId] = costClass;
      next[byKey] = costClass;
    }
  }
  return next;
}

function countAnalyticClasses(compositions: AdditiveComposition[]) {
  const counts: Record<MaterialCostClass, number> = {
    material: 0,
    labor: 0,
    equipment: 0,
    unclassified: 0,
  };
  for (const composition of compositions) {
    for (const input of composition.inputs ?? []) {
      counts[guessAnalyticInputClass(input)] += 1;
    }
  }
  return counts;
}

function normalizeAnalyticCode(value?: string) {
  return (value ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function parsePercentInput(value: string): number | undefined {
  return parseBdiInput(value);
}

function buildContractDraft(project: Project, bdi?: number): ContractDraft {
  const ci = project.contractInfo ?? {};
  const bdiValue = bdi ?? project.syntheticBdiPercent ?? ci.bdiPercent;
  return {
    projectName: project.name || '',
    contractor: ci.contractor || '',
    contracted: ci.contracted || '',
    location: ci.location || '',
    contractObject: ci.contractObject || '',
    contractNumber: ci.contractNumber || '',
    artNumber: ci.artNumber || '',
    budgetSource: ci.budgetSource || '',
    bdiPercent: bdiValue !== undefined && Number.isFinite(bdiValue) ? String(bdiValue).replace('.', ',') : '',
    biddingDiscountPercent: ci.biddingDiscountPercent !== undefined && Number.isFinite(ci.biddingDiscountPercent)
      ? String(ci.biddingDiscountPercent).replace('.', ',')
      : '',
  };
}

function normalizeBudgetItemNumber(value?: string) {
  return (value ?? '')
    .trim()
    .toUpperCase()
    .split('.')
    .map(part => /^\d+$/.test(part) ? String(parseInt(part, 10)) : part)
    .join('.');
}

function budgetItemNumber(value: { item?: string; itemNumber?: string }) {
  return value.itemNumber || value.item || '';
}

function analyticInputGroupKey(input: { code?: string; description: string; unit?: string }) {
  const code = normalizeAnalyticCode(input.code);
  if (code) return `code:${code}`;
  return `desc:${input.description.trim().toLowerCase()}|${(input.unit ?? '').trim().toLowerCase()}`;
}

function safeIdPart(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'item';
}

function sameBudgetKey(a: { item?: string; itemNumber?: string; code?: string }, b: { item?: string; itemNumber?: string; code?: string }) {
  const normalizeItem = (value?: string) => (value ?? '')
    .trim()
    .replace(',', '.')
    .split('.')
    .filter(Boolean)
    .map(part => /^\d+$/.test(part) ? String(Number(part)) : part.toUpperCase())
    .join('.');
  return normalizeItem(a.itemNumber || a.item) === normalizeItem(b.itemNumber || b.item)
    && normalizeAnalyticCode(a.code) === normalizeAnalyticCode(b.code);
}

function findAnalyticForBudget(compositions: AdditiveComposition[], item: BudgetItem) {
  return compositions.find(c => c.linkedTaskId === item.taskId || c.taskId === item.taskId)
    ?? compositions.find(c => sameBudgetKey(c, item));
}

function buildLaborFromAnalytic(composition?: AdditiveComposition): LaborComposition[] {
  if (!composition) return [];
  return (composition.inputs ?? [])
    .filter(input => guessAnalyticInputClass(input) === 'labor')
    .map(input => ({
      id: `lc-${composition.id}-${input.id}`,
      role: input.description || input.code || 'Mao de obra',
      originalRole: input.description,
      rup: Number(input.coefficient || 0),
      workerCount: 1,
      hourlyRate: Number(input.unitPrice || 0) || undefined,
    }))
    .filter(labor => labor.rup > 0);
}

function buildImportedTask(item: BudgetItem, phaseName: string, laborCompositions: LaborComposition[], order: number, projectStartDate: string): Task {
  const taskId = item.taskId ?? `budget-${item.id}`;
  const base: Task = {
    id: taskId,
    name: item.description,
    phase: phaseName,
    startDate: projectStartDate,
    duration: 1,
    dependencies: [],
    dependencyDetails: [],
    responsible: '',
    percentComplete: 0,
    materials: [],
    level: 0,
    contractOrder: order,
    scheduleOrder: order,
    originalOrder: order,
    publicSheetOrder: order,
    durationMode: laborCompositions.length ? 'rup' : 'manual',
    isManual: !laborCompositions.length,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPriceWithBDI,
    unitPriceNoBDI: item.unitPriceNoBDI,
    itemCode: item.code,
    contractItem: item.item,
    priceBank: item.bank,
    laborCompositions,
  };
  if (!laborCompositions.length) return base;
  const calc = calculateRupDuration(base);
  return {
    ...base,
    duration: Math.max(1, calc.duration),
    calculatedDuration: Math.max(1, calc.duration),
    totalHours: calc.totalHours,
    calendarHours: calc.calendarHours,
    bottleneckRole: calc.bottleneckRole,
  };
}

export function integrateImportedBudget(project: Project, budgetItems: BudgetItem[], analyticCompositions: AdditiveComposition[]) {
  const phases = [...project.phases];
  const chapterIndex = new Map<string, string>();
  const subchapterIndex = new Map<string, string>();

  const ensurePhase = (name: string, code: string, parentId?: string): Phase => {
    const key = `${parentId ?? 'root'}|${code || name}`;
    const indexMap = parentId ? subchapterIndex : chapterIndex;
    const existingId = indexMap.get(key)
      ?? phases.find(p => (p.parentId ?? '') === (parentId ?? '') && (p.customNumber === code || p.name === name))?.id;
    if (existingId) {
      const found = phases.find(p => p.id === existingId);
      if (found) {
        indexMap.set(key, found.id);
        return found;
      }
    }
    const siblings = phases.filter(p => (p.parentId ?? null) === (parentId ?? null));
    const phase: Phase = {
      id: `phase-import-${safeIdPart(code || name)}-${Date.now()}-${phases.length}`,
      name,
      color: PHASE_COLORS[phases.length % PHASE_COLORS.length],
      tasks: [],
      parentId,
      customNumber: code || undefined,
      order: siblings.length,
    };
    phases.push(phase);
    indexMap.set(key, phase.id);
    return phase;
  };

  const linkedBudgetItems = budgetItems.map(item => ({ ...item, taskId: item.taskId ?? `budget-${item.id}` }));

  linkedBudgetItems.forEach((item, order) => {
    const chapterName = item.chapterName || item.subchapterName || 'Orcamento importado';
    const chapterCode = item.chapterCode || item.item.split('.')[0] || '';
    const chapter = ensurePhase(chapterName, chapterCode);
    const targetPhase = item.subchapterName
      ? ensurePhase(item.subchapterName, item.subchapterCode || item.item.split('.').slice(0, 2).join('.'), chapter.id)
      : chapter;
    const analytic = findAnalyticForBudget(analyticCompositions, item);
    const laborCompositions = buildLaborFromAnalytic(analytic);
    const nextTask = buildImportedTask(item, targetPhase.name, laborCompositions, order, project.startDate);
    const phaseIndex = phases.findIndex(p => p.id === targetPhase.id);
    if (phaseIndex < 0) return;
    const existingTaskIndex = phases[phaseIndex].tasks.findIndex(t =>
      t.id === nextTask.id || sameBudgetKey({ item: t.contractItem, code: t.itemCode }, item),
    );
    const tasks = existingTaskIndex >= 0
      ? phases[phaseIndex].tasks.map((task, idx) => idx === existingTaskIndex ? { ...task, ...nextTask, dailyLogs: task.dailyLogs, percentComplete: task.percentComplete } : task)
      : [...phases[phaseIndex].tasks, nextTask];
    phases[phaseIndex] = { ...phases[phaseIndex], tasks };
  });

  const taskIdByBudgetId = new Map(linkedBudgetItems.map(item => [item.id, item.taskId]));
  const linkedAnalytic = analyticCompositions.map(composition => {
    const budget = linkedBudgetItems.find(item =>
      item.taskId === composition.linkedTaskId ||
      item.taskId === composition.taskId ||
      sameBudgetKey(composition, item)
    );
    const linkedTaskId = budget?.taskId ?? composition.linkedTaskId ?? composition.taskId;
    return linkedTaskId ? {
      ...composition,
      item: budget?.item ?? composition.item,
      itemNumber: budget?.item ?? composition.itemNumber,
      code: composition.code || budget?.code,
      bank: composition.bank || budget?.bank,
      description: composition.description || budget?.description,
      taskId: linkedTaskId,
      linkedTaskId,
    } : composition;
  });

  return {
    phases,
    budgetItems: linkedBudgetItems.map(item => ({ ...item, taskId: taskIdByBudgetId.get(item.id) ?? item.taskId })),
    analyticCompositions: linkedAnalytic,
  };
}

export default function ImportSyntheticDialog({
  open,
  onClose,
  project,
  onProjectChange,
  mode = 'update',
  existingProjectNames = [],
  onCreateProject,
}: Props) {
  const isCreateMode = mode === 'create';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedSynthetic | null>(null);
  const [structuralNames, setStructuralNames] = useState<Record<string, string>>({});
  const [syntheticBuffer, setSyntheticBuffer] = useState<ArrayBuffer | null>(null);
  const [preview, setPreview] = useState<SyntheticWorkbookPreview | null>(null);
  const [columnRoles, setColumnRoles] = useState<SyntheticColumnRole[]>(DEFAULT_COLUMN_ROLES);
  const [headerRow, setHeaderRow] = useState(9);
  const [firstDataRow, setFirstDataRow] = useState(10);
  const [bdiInput, setBdiInput] = useState('');
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [contractDraft, setContractDraft] = useState<ContractDraft>(() => buildContractDraft(project));
  const [creationStep, setCreationStep] = useState<'name' | 'import'>(isCreateMode ? 'name' : 'import');
  const [projectNameInput, setProjectNameInput] = useState('');
  const [projectNameTouched, setProjectNameTouched] = useState(false);
  const [savingImport, setSavingImport] = useState(false);
  const projectNameInputRef = useRef<HTMLInputElement>(null);

  // Analítica (pode vir no mesmo arquivo da Sintética OU em arquivo separado).
  const [analyticCompositions, setAnalyticCompositions] = useState<AdditiveComposition[] | null>(null);
  const [analyticFileName, setAnalyticFileName] = useState('');
  const [analyticInfo, setAnalyticInfo] = useState<string>('');
  const [analyticLoading, setAnalyticLoading] = useState(false);
  const [analyticOk, setAnalyticOk] = useState(false);
  const [analyticBuffer, setAnalyticBuffer] = useState<ArrayBuffer | null>(null);
  const [analyticPreview, setAnalyticPreview] = useState<AnalyticWorkbookPreview | null>(null);
  const [analyticColumnRoles, setAnalyticColumnRoles] = useState<AnalyticColumnRole[]>(DEFAULT_ANALYTIC_COLUMN_ROLES);
  const [analyticHeaderRow, setAnalyticHeaderRow] = useState(1);
  const [analyticFirstDataRow, setAnalyticFirstDataRow] = useState(2);
  const [showAnalyticClassReview, setShowAnalyticClassReview] = useState(false);
  const [analyticClassFilter, setAnalyticClassFilter] = useState<MaterialCostClass | 'all'>('all');
  const [analyticUnitSort, setAnalyticUnitSort] = useState<'none' | 'asc' | 'desc'>('none');
  const [selectedAnalyticInputGroups, setSelectedAnalyticInputGroups] = useState<Set<string>>(() => new Set());

  const normalizedProjectName = useMemo(() => normalizeProjectName(projectNameInput), [projectNameInput]);
  const duplicateProjectName = useMemo(() => {
    if (!normalizedProjectName) return false;
    const current = comparableProjectName(normalizedProjectName);
    return existingProjectNames.some(name => comparableProjectName(name) === current);
  }, [existingProjectNames, normalizedProjectName]);
  const projectNameValidation = !projectNameTouched && !projectNameInput
    ? ''
    : !normalizedProjectName
      ? 'Informe o nome da obra para continuar.'
      : duplicateProjectName
        ? 'Ja existe uma obra com este nome. Escolha outro nome.'
        : '';
  const canContinueProjectName = !!normalizedProjectName && !duplicateProjectName && !savingImport;
  const hasUnsavedImportProgress = !!(
    fileName ||
    parsed ||
    syntheticBuffer ||
    preview ||
    analyticFileName ||
    analyticCompositions ||
    analyticBuffer ||
    analyticPreview
  );

  const reset = () => {
    setLoading(false);
    setError('');
    setFileName('');
    setParsed(null);
    setStructuralNames({});
    setSyntheticBuffer(null);
    setPreview(null);
    setColumnRoles(DEFAULT_COLUMN_ROLES);
    setHeaderRow(9);
    setFirstDataRow(10);
    setBdiInput('');
    setWizardStep(1);
    setContractDraft(buildContractDraft(project));
    setCreationStep(isCreateMode ? 'name' : 'import');
    setProjectNameInput('');
    setProjectNameTouched(false);
    setSavingImport(false);
    setAnalyticCompositions(null);
    setAnalyticFileName('');
    setAnalyticInfo('');
    setAnalyticLoading(false);
    setAnalyticOk(false);
    setAnalyticBuffer(null);
    setAnalyticPreview(null);
    setAnalyticColumnRoles(DEFAULT_ANALYTIC_COLUMN_ROLES);
    setAnalyticHeaderRow(1);
    setAnalyticFirstDataRow(2);
    setShowAnalyticClassReview(false);
    setAnalyticClassFilter('all');
    setAnalyticUnitSort('none');
    setSelectedAnalyticInputGroups(new Set());
  };
  const handleClose = () => {
    if (savingImport) return;
    if (isCreateMode && creationStep === 'import' && hasUnsavedImportProgress) {
      const shouldClose = window.confirm('Cancelar a criacao da obra? Os arquivos e leituras desta importacao serao descartados.');
      if (!shouldClose) return;
    }
    reset();
    onClose();
  };

  useEffect(() => {
    if (open && isCreateMode && creationStep === 'name') {
      window.requestAnimationFrame(() => projectNameInputRef.current?.focus());
    }
  }, [creationStep, isCreateMode, open]);

  const continueFromProjectName = () => {
    setProjectNameTouched(true);
    if (!canContinueProjectName) return;
    setContractDraft(current => ({ ...current, projectName: normalizedProjectName }));
    setCreationStep('import');
    setWizardStep(1);
  };

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError('');
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const inspected = inspectSyntheticWorkbook(buf);
      const nextHeaderRow = inspected.suggestedHeaderRowIndex + 1;
      const nextFirstDataRow = nextHeaderRow + 1;
      const detectedRoles = detectSyntheticColumnRoles(inspected.rows, inspected.suggestedHeaderRowIndex);
      setSyntheticBuffer(buf);
      setPreview(inspected);
      setColumnRoles(detectedRoles);
      setHeaderRow(nextHeaderRow);
      setFirstDataRow(nextFirstDataRow);
      // O BDI deve ser informado manualmente no cadastro; nunca copiar o BDI da planilha.
      setBdiInput('');
      const result = parseSyntheticBudgetFlexible(buf, {
        sheetName: inspected.sheetName,
        headerRowIndex: inspected.suggestedHeaderRowIndex,
        firstDataRowIndex: inspected.suggestedHeaderRowIndex + 1,
        columns: rolesToMap(detectedRoles),
      });
      if (result.items.length === 0) {
        setError('Nenhum item financeiro encontrado na planilha Sintética.');
        setLoading(false);
        return;
      }
      setParsed(result);
      setStructuralNames({});
      setWizardStep(1);

      // Tenta extrair a Analítica do MESMO arquivo (aba Analítica).
      try {
        const an = await extractBaseAnalyticCompositions(buf);
        if (an.hasAnalyticSheet && an.compositions.length > 0) {
          const missing = findMissingAnalyticItems(result.items, an.compositions);
          setAnalyticCompositions(classifyAnalyticCompositions(an.compositions));
          setAnalyticOk(missing.length === 0);
          setAnalyticInfo(
            missing.length === 0
              ? `Analitica detectada no mesmo arquivo: ${an.compositions.length} composicoes c/ insumos (${an.totalInputs} insumos).`
              : `Analitica detectada, mas ${missing.length} servico(s) da Sintetica ficaram sem vinculo. Corrija a Analitica antes de concluir.`,
          );
        } else {
          setAnalyticCompositions(null);
          setAnalyticOk(false);
          setAnalyticInfo('Aba Analítica não encontrada neste arquivo — você pode anexá-la abaixo.');
        }
      } catch (err: unknown) {
        setAnalyticCompositions(null);
        setAnalyticOk(false);
        setAnalyticInfo(`Falha ao ler Analítica deste arquivo: ${errorMessage(err, 'erro desconhecido')}.`);
      }
    } catch (e: unknown) {
      setError(`Erro ao ler a Sintética: ${errorMessage(e, 'formato não reconhecido')}`);
    }
    setLoading(false);
  }, []);

  /** Importação da Analítica em arquivo separado, vinculando à Sintética. */
  const handleAnalyticFile = useCallback(async (file: File) => {
    setAnalyticLoading(true);
    setAnalyticInfo('');
    setAnalyticFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const inspected = await inspectAnalyticWorkbook(buf);
      setShowAnalyticClassReview(false);
      setAnalyticClassFilter('all');
      const nextHeaderRow = inspected.suggestedHeaderRowIndex + 1;
      const nextFirstDataRow = inspected.suggestedFirstDataRowIndex + 1;
      const detectedAnalyticRoles = detectAnalyticColumnRoles(inspected.rows, inspected.suggestedHeaderRowIndex, inspected.hasHeaderRow);
      setAnalyticBuffer(buf);
      setAnalyticPreview(inspected);
      setAnalyticColumnRoles(detectedAnalyticRoles);
      setAnalyticHeaderRow(nextHeaderRow);
      setAnalyticFirstDataRow(nextFirstDataRow);
      // Base de vínculo: itens recém-parseados (se houver) ou os já salvos no projeto.
      const baseItems: BudgetItem[] = parsed
        ? parsed.items
        : (project.budgetItems ?? []).filter(b => b.source === 'sintetica');
      const an = await extractBaseAnalyticCompositionsFromAnalyticFile(buf, baseItems, {
        sheetName: inspected.sheetName,
        headerRowIndex: inspected.suggestedHeaderRowIndex,
        firstDataRowIndex: inspected.suggestedFirstDataRowIndex,
        columns: analyticRolesToMap(detectedAnalyticRoles),
      });
      if (!an.hasAnalyticSheet) {
        setAnalyticOk(false);
        setAnalyticCompositions(null);
        setAnalyticInfo('Aba Analítica não encontrada no arquivo selecionado.');
      } else if (an.compositions.length === 0) {
        setAnalyticOk(false);
        setAnalyticCompositions([]);
        setAnalyticInfo(an.message || 'Analítica lida, mas nenhum bloco vinculou à Sintética.');
      } else {
        const missing = findMissingAnalyticItems(baseItems, an.compositions);
        setAnalyticOk(missing.length === 0);
        setAnalyticCompositions(classifyAnalyticCompositions(an.compositions));
        setAnalyticInfo(
          missing.length === 0
            ? an.message
            : `${an.message} Faltam ${missing.length} serviço(s) da Sintética sem Analítica vinculada.`,
        );
        setShowAnalyticClassReview(false);
        if (missing.length === 0 || !isCreateMode) setWizardStep(2);
      }
    } catch (err: unknown) {
      setAnalyticOk(false);
      setAnalyticCompositions(null);
      setAnalyticInfo(`Falha ao ler Analítica: ${errorMessage(err, 'erro desconhecido')}.`);
    }
    setAnalyticLoading(false);
  }, [isCreateMode, parsed, project.budgetItems]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const handleAnalyticDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleAnalyticFile(f);
  }, [handleAnalyticFile]);

  const updateAnalyticInputGroupClass = useCallback((groupKey: string, costClass: MaterialCostClass) => {
    setAnalyticCompositions(current => current?.map(composition => ({
      ...composition,
      inputs: (composition.inputs ?? []).map(input =>
        analyticInputGroupKey(input) === groupKey ? { ...input, type: inputTypeFromClass(costClass) } : input,
      ),
    })) ?? current);
  }, []);

  const updateAnalyticInputGroupsClass = useCallback((groupKeys: Set<string>, costClass: MaterialCostClass) => {
    setAnalyticCompositions(current => current?.map(composition => ({
      ...composition,
      inputs: (composition.inputs ?? []).map(input =>
        groupKeys.has(analyticInputGroupKey(input)) ? { ...input, type: inputTypeFromClass(costClass) } : input,
      ),
    })) ?? current);
  }, []);

  const reprocessSynthetic = useCallback(() => {
    if (!syntheticBuffer || !preview) return;
    setError('');
    const result = parseSyntheticBudgetFlexible(syntheticBuffer, {
      sheetName: preview.sheetName,
      headerRowIndex: Math.max(0, headerRow - 1),
      firstDataRowIndex: Math.max(0, firstDataRow - 1),
      columns: rolesToMap(columnRoles),
    });
    if (result.items.length === 0) {
      setError('Nenhum item financeiro encontrado com esta configuracao de colunas.');
      setParsed(null);
      return;
    }
    setParsed(result);
    setStructuralNames({});
    setWizardStep(2);
  }, [syntheticBuffer, preview, headerRow, firstDataRow, columnRoles, bdiInput]);

  const reprocessAnalytic = useCallback(async () => {
    if (!analyticBuffer || !analyticPreview) return;
    setAnalyticLoading(true);
    setAnalyticInfo('');
    try {
      setShowAnalyticClassReview(false);
      setAnalyticClassFilter('all');
      const baseItems: BudgetItem[] = parsed
        ? parsed.items
        : (project.budgetItems ?? []).filter(b => b.source === 'sintetica');
      const an = await extractBaseAnalyticCompositionsFromAnalyticFile(analyticBuffer, baseItems, {
        sheetName: analyticPreview.sheetName,
        headerRowIndex: Math.max(0, analyticHeaderRow - 1),
        firstDataRowIndex: Math.max(0, analyticFirstDataRow - 1),
        columns: analyticRolesToMap(analyticColumnRoles),
      });
      if (!an.hasAnalyticSheet) {
        setAnalyticOk(false);
        setAnalyticCompositions(null);
        setAnalyticInfo('Aba Analitica nao encontrada no arquivo selecionado.');
      } else if (an.compositions.length === 0) {
        setAnalyticOk(false);
        setAnalyticCompositions([]);
        setAnalyticInfo(an.message || 'Analitica lida, mas nenhum bloco vinculou a Sintetica.');
      } else {
        const missing = findMissingAnalyticItems(baseItems, an.compositions);
        setAnalyticOk(missing.length === 0);
        setAnalyticCompositions(classifyAnalyticCompositions(an.compositions));
        setAnalyticInfo(
          missing.length === 0
            ? an.message
            : `${an.message} Faltam ${missing.length} serviço(s) da Sintética sem Analítica vinculada.`,
        );
        setShowAnalyticClassReview(false);
        if (missing.length === 0 || !isCreateMode) setWizardStep(2);
      }
    } catch (err: unknown) {
      setAnalyticOk(false);
      setAnalyticCompositions(null);
      setAnalyticInfo(`Falha ao ler Analitica: ${errorMessage(err, 'erro desconhecido')}.`);
    }
    setAnalyticLoading(false);
  }, [analyticBuffer, analyticPreview, analyticHeaderRow, analyticFirstDataRow, analyticColumnRoles, isCreateMode, parsed, project.budgetItems]);

  const finishImport = async (nextProject: Project) => {
    const finalName = normalizeProjectName(nextProject.name);
    if (isCreateMode) {
      if (!finalName) {
        setError('Informe o nome da obra antes de concluir a importacao.');
        setCreationStep('name');
        return;
      }
      if (existingProjectNames.some(name => comparableProjectName(name) === comparableProjectName(finalName))) {
        setError('Ja existe uma obra com este nome. Volte e informe outro nome.');
        setWizardStep(5);
        return;
      }
      if (!onCreateProject) {
        setError('Nao foi possivel concluir a criacao da obra.');
        return;
      }
      setSavingImport(true);
      setError('');
      try {
        await onCreateProject({ ...nextProject, name: finalName });
        reset();
        onClose();
      } catch (err) {
        console.warn(err);
        setError(err instanceof Error ? err.message : 'Erro ao criar a obra com a importacao.');
      } finally {
        setSavingImport(false);
      }
      return;
    }
    onProjectChange({ ...nextProject, name: finalName || project.name });
    handleClose();
  };

  const confirmImport = async () => {
    const contractBdi = parsePercentInput(contractDraft.bdiPercent);
    const contractDiscount = parsePercentInput(contractDraft.biddingDiscountPercent);
    const selectedProjectName = normalizeProjectName(contractDraft.projectName || projectNameInput || project.name);
    const importedItems = (parsed?.items ?? []).map(item => ({
      ...item,
      chapterName: item.chapterCode && structuralNames[item.chapterCode]?.trim()
        ? structuralNames[item.chapterCode].trim()
        : item.chapterName,
      subchapterName: item.subchapterCode && structuralNames[item.subchapterCode]?.trim()
        ? structuralNames[item.subchapterCode].trim()
        : item.subchapterName,
    }));
    const unresolvedStructuralGroups = (parsed?.groups ?? [])
      .filter(group => group.requiresDescription && !structuralNames[group.code]?.trim())
      .map(group => group.code);
    if (isCreateMode && parsed) {
      const validation = validateNewWorkImport({
        contractBdiPercent: contractBdi,
        budgetItems: importedItems,
        analyticCompositions,
        syntheticErrors: parsed.errors,
        unresolvedStructuralGroups,
      });
      if (!validation.isValid) {
        setError(validation.errors.join(' '));
        setWizardStep(validation.missingAnalytics.length > 0 ? 2 : 5);
        return;
      }
    }
    const nextContractInfo = {
      ...(project.contractInfo ?? {}),
      contractor: contractDraft.contractor,
      contracted: contractDraft.contracted,
      location: contractDraft.location,
      contractObject: contractDraft.contractObject,
      contractNumber: contractDraft.contractNumber,
      artNumber: contractDraft.artNumber,
      budgetSource: contractDraft.budgetSource,
      bdiPercent: contractBdi,
      biddingDiscountPercent: contractDiscount,
    };
    // Caso 1: importação completa de Sintética (+ opcional Analítica).
    if (parsed) {
      const keep = (project.budgetItems ?? []).filter(b => b.source !== 'sintetica');
      const importedBudgetItems = importedItems.map(item => ({ ...item, taskId: item.taskId ?? `budget-${item.id}` }));
      const priced = priceNewContractFromAnalytic(importedBudgetItems, analyticCompositions ?? [], contractBdi ?? 0);
      const classified = classifyAnalyticCompositions(priced.compositions);
      const integration = integrateImportedBudget(project, priced.items, classified);
      const next: BudgetItem[] = [...keep, ...integration.budgetItems];
      const nextProject: Project = {
        ...project,
        name: selectedProjectName || project.name,
        contractSchemaVersion: isCreateMode ? 2 : (project.contractSchemaVersion ?? 1),
        analyticLinkSchemaVersion: 2,
        contractRevisions: project.contractRevisions ?? [],
        contractRectifications: project.contractRectifications ?? [],
        costLedger: project.costLedger ?? [],
        contractInfo: nextContractInfo,
        budgetItems: next,
        phases: integration.phases,
        analyticCompositions: integration.analyticCompositions,
        materialCostClasses: classified.length > 0 ? mergeAnalyticCostClasses(project, classified) : project.materialCostClasses,
        syntheticBdiPercent: contractBdi,
        syntheticImportedAt: new Date().toISOString(),
      };
      await finishImport(nextProject);
      return;
    }
    // Caso 2: somente Analítica (sem nova Sintética) — atualiza apenas analyticCompositions.
    if (analyticCompositions && analyticCompositions.length > 0) {
      const classified = classifyAnalyticCompositions(analyticCompositions);
      const existingSyntheticItems = (project.budgetItems ?? [])
        .filter(item => item.source === 'sintetica')
        .map(item => ({ ...item, taskId: item.taskId ?? `budget-${item.id}` }));
      const integration = existingSyntheticItems.length > 0
        ? integrateImportedBudget(project, existingSyntheticItems, classified)
        : null;
      const budgetById = new Map((integration?.budgetItems ?? []).map(item => [item.id, item]));
      await finishImport({
        ...project,
        name: selectedProjectName || project.name,
        contractInfo: nextContractInfo,
        syntheticBdiPercent: contractBdi ?? project.syntheticBdiPercent,
        budgetItems: integration
          ? (project.budgetItems ?? []).map(item => item.source === 'sintetica' ? (budgetById.get(item.id) ?? item) : item)
          : project.budgetItems,
        phases: integration?.phases ?? project.phases,
        analyticCompositions: integration?.analyticCompositions ?? classified,
        materialCostClasses: mergeAnalyticCostClasses(project, classified),
      });
      return;
    }
  };

  const reviewPriced = parsed
    ? priceNewContractFromAnalytic(parsed.items, analyticCompositions ?? [], parsePercentInput(contractDraft.bdiPercent) ?? 0).items
    : [];
  const reviewBudgetItems = parsed
    ? reviewPriced.map(item => ({
        ...item,
        chapterName: item.chapterCode && structuralNames[item.chapterCode]?.trim()
          ? structuralNames[item.chapterCode].trim()
          : item.chapterName,
        subchapterName: item.subchapterCode && structuralNames[item.subchapterCode]?.trim()
          ? structuralNames[item.subchapterCode].trim()
          : item.subchapterName,
      }))
    : (project.budgetItems ?? []).filter(item => item.source === 'sintetica');
  const unresolvedStructuralGroups = (parsed?.groups ?? [])
    .filter(group => group.requiresDescription && !structuralNames[group.code]?.trim())
    .map(group => group.code);
  const totalNoBDI = reviewBudgetItems.reduce((s, i) => s + i.totalNoBDI, 0) ?? 0;
  const totalWithBDI = reviewBudgetItems.reduce((s, i) => s + i.totalWithBDI, 0) ?? 0;
  const hasAnalytic = !!(analyticCompositions && analyticCompositions.length > 0);
  const hasExistingSynthetic = (project.budgetItems ?? []).some(b => b.source === 'sintetica');
  const missingAnalyticItems = parsed
    ? findMissingAnalyticItems(parsed.items, analyticCompositions)
    : [];
  const newWorkImportValidation = isCreateMode && parsed
    ? validateNewWorkImport({
        contractBdiPercent: parsePercentInput(contractDraft.bdiPercent),
        budgetItems: reviewBudgetItems,
        analyticCompositions,
        syntheticErrors: parsed.errors,
        unresolvedStructuralGroups,
      })
    : null;
  const completeAnalyticForNewWork = !isCreateMode || !parsed || missingAnalyticItems.length === 0;
  const canGoNext =
    wizardStep === 1 ? !!parsed
    : wizardStep === 2 ? hasAnalytic && completeAnalyticForNewWork
    : wizardStep === 3 ? hasAnalytic && completeAnalyticForNewWork
    : wizardStep === 4 ? (!!parsed || hasExistingSynthetic)
    : true;
  const goNextStep = () => {
    if (wizardStep === 1 && parsed) setWizardStep(2);
    else if (wizardStep === 2 && hasAnalytic && completeAnalyticForNewWork) {
      setShowAnalyticClassReview(true);
      setWizardStep(3);
    } else if (wizardStep === 3 && hasAnalytic && completeAnalyticForNewWork) setWizardStep(4);
    else if (wizardStep === 4) setWizardStep(5);
  };
  const goPreviousStep = () => setWizardStep(step => Math.max(1, step - 1) as 1 | 2 | 3 | 4 | 5);
  const analyticInputGroups = Array.from((analyticCompositions ?? []).reduce((map, composition) => {
    for (const input of composition.inputs ?? []) {
      const key = analyticInputGroupKey(input);
      const coefficient = Number(input.coefficient || 0);
      const contractedQty = Number(composition.quantity || 0);
      const totalQty = coefficient * contractedQty;
      const unitPrice = Number(input.unitPrice || 0);
      const existing = map.get(key);
      const costClass = guessAnalyticInputClass(input);
      if (existing) {
        existing.totalQuantity += totalQty;
        existing.totalValue += totalQty * unitPrice;
        existing.occurrences += 1;
        existing.compositionItems.add(composition.item);
        existing.costClassCounts[costClass] += 1;
      } else {
        map.set(key, {
          key,
          code: input.code || '-',
          description: input.description,
          unit: input.unit || '-',
          unitPrice,
          totalQuantity: totalQty,
          totalValue: totalQty * unitPrice,
          occurrences: 1,
          compositionItems: new Set<string>([composition.item]),
          costClassCounts: {
            material: costClass === 'material' ? 1 : 0,
            labor: costClass === 'labor' ? 1 : 0,
            equipment: costClass === 'equipment' ? 1 : 0,
            unclassified: costClass === 'unclassified' ? 1 : 0,
          } as Record<MaterialCostClass, number>,
        });
      }
    }
    return map;
  }, new Map<string, {
    key: string;
    code: string;
    description: string;
    unit: string;
    unitPrice: number;
    totalQuantity: number;
    totalValue: number;
    occurrences: number;
    compositionItems: Set<string>;
    costClassCounts: Record<MaterialCostClass, number>;
  }>()).values()).map(group => {
    const costClass = COST_CLASS_OPTIONS.reduce((best, current) =>
      group.costClassCounts[current] > group.costClassCounts[best] ? current : best,
    'unclassified' as MaterialCostClass);
    return { ...group, costClass };
  }).sort((a, b) => a.description.localeCompare(b.description, 'pt-BR'));
  const analyticClassCounts = analyticCompositions?.length ? analyticInputGroups.reduce((counts, group) => {
    counts[group.costClass] += 1;
    return counts;
  }, {
    material: 0,
    labor: 0,
    equipment: 0,
    unclassified: 0,
  } as Record<MaterialCostClass, number>) : null;
  const filteredAnalyticInputGroups = analyticClassFilter === 'all'
    ? [...analyticInputGroups]
    : analyticInputGroups.filter(row => row.costClass === analyticClassFilter);
  if (analyticUnitSort !== 'none') {
    filteredAnalyticInputGroups.sort((a, b) => {
      const unitCompare = a.unit.localeCompare(b.unit, 'pt-BR', { numeric: true, sensitivity: 'base' });
      const descCompare = a.description.localeCompare(b.description, 'pt-BR');
      return analyticUnitSort === 'asc'
        ? unitCompare || descCompare
        : -unitCompare || descCompare;
    });
  }
  const analyticClassSummary = analyticClassCounts ? (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
      {COST_CLASS_OPTIONS.map(costClass => (
        <div key={costClass} className="rounded-md border border-border bg-background px-2 py-1.5">
          <div className="text-[10px] text-muted-foreground">{MATERIAL_COST_CLASS_LABEL[costClass]}</div>
          <div className="text-xs font-semibold text-foreground">{analyticClassCounts[costClass]} insumo(s)</div>
        </div>
      ))}
    </div>
  ) : null;
  const stepNotes: Record<1 | 2 | 3 | 4 | 5, string> = {
    1: 'Importe a Sintetica e confira a leitura das colunas. Ela vira a base financeira e estrutural da obra.',
    2: 'Anexe a Analitica e confira se as colunas A-H representam item, codigo, banco, descricao, coeficiente, unidade, valor unitario e total.',
    3: 'Valide os insumos agrupados por codigo. A classificacao define o que entra como mao de obra, material ou equipamento.',
    4: 'Revise o que sera integrado para EAP, Cronograma, Producao, Medicao, Aditivo, Custo Real e Lista de Material.',
    5: 'Preencha os dados iniciais da obra. Eles alimentam os cabecalhos da Medicao, Aditivo, Custo Real e exportacoes.',
  };
  const stepMeta: Record<1 | 2 | 3 | 4 | 5, { title: string; description: string; Icon: React.ElementType }> = {
    1: { title: 'Importar planilha Sintetica', description: 'Base financeira, servicos e capitulos da obra.', Icon: FileSpreadsheet },
    2: { title: 'Importar planilha Analitica', description: 'Composicoes, insumos, mao de obra e produtividade.', Icon: Layers },
    3: { title: 'Classificar insumos', description: 'Revise a classificacao entre material, mao de obra e equipamento.', Icon: ClipboardCheck },
    4: { title: 'Revisar integracao', description: 'Confira os dados que alimentarao os modulos da obra.', Icon: Check },
    5: { title: 'Dados iniciais', description: 'Defina as informacoes iniciais de medicao, aditivo e custo real.', Icon: FileText },
  };
  const currentStepMeta = stepMeta[wizardStep];
  const CurrentStepIcon = currentStepMeta.Icon;
  const setContractField = (field: keyof ContractDraft, value: string) => {
    setContractDraft(current => ({ ...current, [field]: value }));
  };
  const contractDataPanel = (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      <div>
        <div className="text-sm font-semibold text-foreground">5. Dados iniciais da obra</div>
        <div className="text-xs text-muted-foreground">Preencha uma vez para usar nos relatórios e rotinas financeiras.</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {[
          ['projectName', 'Obra'],
          ['contractor', 'Contratante'],
          ['contracted', 'Contratada'],
          ['location', 'Local / Municipio'],
          ['contractObject', 'Objeto'],
          ['contractNumber', 'No do documento / contrato'],
          ['artNumber', 'No da ART'],
          ['budgetSource', 'Fonte de orcamento'],
          ['bdiPercent', 'Valor do BDI (%)'],
          ['biddingDiscountPercent', 'Desconto da licitacao (%)'],
        ].map(([field, label]) => (
          <label key={field} className={field === 'contractObject' ? 'text-[11px] text-muted-foreground md:col-span-2' : 'text-[11px] text-muted-foreground'}>
            {label}
            <input
              value={contractDraft[field as keyof ContractDraft]}
              onChange={e => setContractField(field as keyof ContractDraft, e.target.value)}
              className="mt-1 h-9 w-full rounded border border-border bg-background px-2 text-xs text-foreground"
              placeholder={field === 'bdiPercent' ? 'Ex.: 25' : field === 'biddingDiscountPercent' ? 'Ex.: 6,5' : undefined}
            />
          </label>
        ))}
      </div>
      {isCreateMode && parsed && (
        <div className={`rounded-md border px-3 py-2 text-xs ${
          newWorkImportValidation?.errors.some(message => message.includes('BDI'))
            ? 'border-destructive/30 bg-destructive/5 text-destructive'
            : 'border-info/30 bg-info/5 text-muted-foreground'
        }`}>
          <strong className="text-foreground">Confirmação obrigatória do BDI:</strong>{' '}
          informe o percentual manual do contrato; o BDI da planilha é ignorado.
          {newWorkImportValidation?.errors.some(message => message.includes('BDI')) && (
            <p className="mt-1">{newWorkImportValidation.errors.filter(message => message.includes('BDI')).join(' ')}</p>
          )}
        </div>
      )}
    </div>
  );
  const syntheticConfigPanel = preview ? (
    <div className="w-full rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-xs font-semibold text-foreground">Conferencia da Sintetica A-J</div>
          <div className="text-[11px] text-muted-foreground">Valide as colunas e as linhas; o BDI serÃ¡ informado manualmente no contrato.</div>
        </div>
        <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" onClick={reprocessSynthetic}>
          Atualizar leitura
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="text-[11px] text-muted-foreground">
          Linha do cabecalho
          <input type="number" min={1} value={headerRow} onChange={e => setHeaderRow(Number(e.target.value) || 1)} className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground" />
        </label>
        <label className="text-[11px] text-muted-foreground">
          Primeira linha de dados
          <input type="number" min={1} value={firstDataRow} onChange={e => setFirstDataRow(Number(e.target.value) || 1)} className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground" />
        </label>
        <label className="text-[11px] text-muted-foreground">
          BDI manual (%)
          <input value={bdiInput} onChange={e => { setBdiInput(e.target.value); setContractField('bdiPercent', e.target.value); }} placeholder="Ex.: 22,50" className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground" />
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {COLUMN_LETTERS.map((letter, index) => (
          <label key={letter} className="text-[11px] text-muted-foreground">
            Coluna {letter}
            <select
              value={columnRoles[index]}
              onChange={e => {
                const next = [...columnRoles];
                next[index] = e.target.value as SyntheticColumnRole;
                setColumnRoles(next);
              }}
              className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground"
            >
              {(Object.keys(ROLE_LABELS) as SyntheticColumnRole[]).map(role => (
                <option key={role} value={role}>{ROLE_LABELS[role]}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="overflow-x-auto rounded border border-border bg-background">
        <table className="w-full min-w-[760px] text-[10px]">
          <thead className="bg-muted">
            <tr>
              <th className="px-2 py-1 text-left font-semibold">Linha</th>
              {COLUMN_LETTERS.map(letter => <th key={letter} className="px-2 py-1 text-left font-semibold">{letter}</th>)}
            </tr>
          </thead>
          <tbody>
            {preview.rows.slice(Math.max(0, headerRow - 2), Math.max(0, headerRow - 2) + 6).map((row, idx) => {
              const line = Math.max(0, headerRow - 2) + idx + 1;
              return (
                <tr key={line} className={line === headerRow ? 'border-t border-border bg-primary/5' : 'border-t border-border'}>
                  <td className="px-2 py-1 font-mono text-muted-foreground">{line}</td>
                  {COLUMN_LETTERS.map((_, col) => (
                    <td key={col} className="px-2 py-1 max-w-[160px] truncate" title={row[col]}>{row[col]}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  ) : null;
  const analyticConfigPanel = analyticPreview ? (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      {wizardStep === 2 && (
      <>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-xs font-semibold text-foreground">Configuracao da leitura Analitica A-H</div>
          <div className="text-[11px] text-muted-foreground">Ajuste as colunas e atualize o vinculo com a Sintetica.</div>
        </div>
        <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" onClick={reprocessAnalytic} disabled={analyticLoading}>
          {analyticLoading ? 'Lendo...' : 'Atualizar vinculo'}
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-[11px] text-muted-foreground">
          Linha do cabecalho {analyticPreview.hasHeaderRow ? '' : '(nao detectado)'}
          <input type="number" min={1} value={analyticHeaderRow} onChange={e => setAnalyticHeaderRow(Number(e.target.value) || 1)} className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground" />
        </label>
        <label className="text-[11px] text-muted-foreground">
          Primeira linha da leitura
          <input type="number" min={1} value={analyticFirstDataRow} onChange={e => setAnalyticFirstDataRow(Number(e.target.value) || 1)} className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground" />
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {ANALYTIC_COLUMN_LETTERS.map((letter, index) => (
          <label key={letter} className="text-[11px] text-muted-foreground">
            Coluna {letter}
            <select
              value={analyticColumnRoles[index]}
              onChange={e => {
                const next = [...analyticColumnRoles];
                next[index] = e.target.value as AnalyticColumnRole;
                setAnalyticColumnRoles(next);
              }}
              className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground"
            >
              {(Object.keys(ANALYTIC_ROLE_LABELS) as AnalyticColumnRole[]).map(role => (
                <option key={role} value={role}>{ANALYTIC_ROLE_LABELS[role]}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
      </>
      )}

      {wizardStep === 3 && analyticClassSummary && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[11px] font-semibold text-foreground">Classificacao inicial dos insumos</div>
          </div>
          {analyticClassSummary}
          <div className="text-[10px] text-muted-foreground">
            Regra inicial: unidades H, hora e mes entram como mao de obra quando nao houver indicio melhor. Use Ctrl + clique para selecionar varios insumos; ao mudar a classificacao de um selecionado, todos os selecionados mudam juntos.
          </div>
          {(
            <div className="mt-2 rounded-lg border border-border bg-background">
              <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/40 px-2 py-2">
                <button
                  type="button"
                  onClick={() => setAnalyticClassFilter('all')}
                  className={`rounded border px-2 py-1 text-[10px] ${analyticClassFilter === 'all' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}
                >
                  Todos ({analyticInputGroups.length})
                </button>
                {COST_CLASS_OPTIONS.map(costClass => (
                  <button
                    key={costClass}
                    type="button"
                    onClick={() => setAnalyticClassFilter(costClass)}
                    className={`rounded border px-2 py-1 text-[10px] ${analyticClassFilter === costClass ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}
                  >
                    {MATERIAL_COST_CLASS_LABEL[costClass]} ({analyticClassCounts[costClass]})
                  </button>
                ))}
              </div>
              <div className="max-h-[52vh] overflow-auto">
                <table className="w-full min-w-[920px] text-[10px]">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="px-2 py-1 text-left font-semibold">Codigo</th>
                      <th className="px-2 py-1 text-left font-semibold">Insumo</th>
                      <th className="px-2 py-1 text-center font-semibold">
                        <button
                          type="button"
                          onClick={() => setAnalyticUnitSort(current => current === 'none' ? 'asc' : current === 'asc' ? 'desc' : 'none')}
                          className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-background"
                          title="Ordenar por unidade"
                        >
                          Und
                          <span className="text-[9px] text-muted-foreground">
                            {analyticUnitSort === 'asc' ? '↑' : analyticUnitSort === 'desc' ? '↓' : '↕'}
                          </span>
                        </button>
                      </th>
                      <th className="px-2 py-1 text-right font-semibold">Qtd. total</th>
                      <th className="px-2 py-1 text-right font-semibold">V. unit. ref.</th>
                      <th className="px-2 py-1 text-right font-semibold">Total ref.</th>
                      <th className="px-2 py-1 text-center font-semibold">Composicoes</th>
                      <th className="px-2 py-1 text-left font-semibold">Classificacao</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAnalyticInputGroups.map(group => {
                      const selected = selectedAnalyticInputGroups.has(group.key);
                      return (
                      <tr
                        key={group.key}
                        onClick={event => {
                          setSelectedAnalyticInputGroups(current => {
                            const next = new Set(current);
                            if (event.ctrlKey || event.metaKey) {
                              if (next.has(group.key)) next.delete(group.key);
                              else next.add(group.key);
                              return next;
                            }
                            return new Set([group.key]);
                          });
                        }}
                        className={`border-t border-border cursor-pointer ${selected ? 'bg-primary/10 ring-1 ring-inset ring-primary/30' : 'hover:bg-muted/30'}`}
                      >
                        <td className="px-2 py-1 font-mono">{group.code}</td>
                        <td className="px-2 py-1 max-w-[300px] truncate font-medium" title={group.description}>{group.description}</td>
                        <td className="px-2 py-1 text-center">{group.unit}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{group.totalQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 4 })}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtBRL(group.unitPrice)}</td>
                        <td className="px-2 py-1 text-right tabular-nums font-medium">{fmtBRL(group.totalValue)}</td>
                        <td className="px-2 py-1 text-center tabular-nums" title={Array.from(group.compositionItems).join(', ')}>
                          {group.compositionItems.size}
                        </td>
                        <td className="px-2 py-1">
                          <select
                            value={group.costClass}
                            onClick={event => event.stopPropagation()}
                            onChange={e => {
                              const costClass = e.target.value as MaterialCostClass;
                              const targets = selectedAnalyticInputGroups.has(group.key) && selectedAnalyticInputGroups.size > 0
                                ? selectedAnalyticInputGroups
                                : new Set([group.key]);
                              updateAnalyticInputGroupsClass(targets, costClass);
                            }}
                            className="h-7 w-full rounded border border-border bg-background px-2 text-[10px] text-foreground"
                          >
                            {COST_CLASS_OPTIONS.map(option => (
                              <option key={option} value={option}>{MATERIAL_COST_CLASS_LABEL[option]}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                      );
                    })}
                    {filteredAnalyticInputGroups.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-2 py-6 text-center text-muted-foreground">
                          Nenhum insumo nesta classificacao.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {wizardStep === 2 && (
      <div className="overflow-x-auto rounded border border-border bg-background">
        <table className="w-full min-w-[720px] text-[10px]">
          <thead className="bg-muted">
            <tr>
              <th className="px-2 py-1 text-left font-semibold">Linha</th>
              {ANALYTIC_COLUMN_LETTERS.map(letter => <th key={letter} className="px-2 py-1 text-left font-semibold">{letter}</th>)}
            </tr>
          </thead>
          <tbody>
            {analyticPreview.rows.slice(Math.max(0, analyticHeaderRow - 2), Math.max(0, analyticHeaderRow - 2) + 7).map((row, idx) => {
              const line = Math.max(0, analyticHeaderRow - 2) + idx + 1;
              return (
                <tr key={line} className={line === analyticHeaderRow ? 'border-t border-border bg-warning/10' : 'border-t border-border'}>
                  <td className="px-2 py-1 font-mono text-muted-foreground">{line}</td>
                  {ANALYTIC_COLUMN_LETTERS.map((_, col) => (
                    <td key={col} className="px-2 py-1 max-w-[160px] truncate" title={row[col]}>{row[col]}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  ) : null;

  return (
    <Dialog open={open} onOpenChange={v => !v && handleClose()}>
      <DialogContent className="w-[96vw] max-w-7xl max-h-[96vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0 space-y-2 border-b border-border pb-3">
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <DollarSign className="w-5 h-5 text-primary" />
            {isCreateMode ? 'Criar nova obra' : 'Atualizar planilha da obra'}
          </DialogTitle>
          {isCreateMode && creationStep === 'name' ? (
            <DialogDescription>
              Etapa principal 1 de 2 - Identificacao da obra
            </DialogDescription>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{isCreateMode ? 'Etapa principal 2 de 2 - Importacao da planilha' : 'Atualizacao da planilha'}</span>
                <span className="font-medium text-primary">Passo {wizardStep} de 5</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${(wizardStep / 5) * 100}%` }}
                />
              </div>
              <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                <CurrentStepIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">
                    Passo {wizardStep} de 5 - {currentStepMeta.title}
                  </div>
                  <div className="text-xs leading-snug text-muted-foreground">
                    {currentStepMeta.description}
                  </div>
                </div>
              </div>
              <div className="rounded-md border border-info/20 bg-info/5 px-3 py-1.5 text-xs text-muted-foreground">
                <strong className="text-foreground">Observacao:</strong> {stepNotes[wizardStep]}
              </div>
            </div>
          )}
        </DialogHeader>

        {isCreateMode && creationStep === 'name' ? (
          <div className="flex-1 min-h-0 overflow-y-auto py-4">
            <div className="mx-auto w-full max-w-xl rounded-lg border border-border bg-muted/20 p-4 space-y-3">
              <label className="text-sm font-medium text-foreground">
                Nome da obra
                <input
                  ref={projectNameInputRef}
                  value={projectNameInput}
                  onChange={e => {
                    setProjectNameInput(e.target.value);
                    setProjectNameTouched(true);
                    if (error) setError('');
                  }}
                  onBlur={() => setProjectNameTouched(true)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && canContinueProjectName) continueFromProjectName();
                  }}
                  placeholder="Digite o nome da obra"
                  className="mt-2 h-10 w-full rounded border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </label>
              {projectNameValidation && (
                <p className="text-xs text-destructive">{projectNameValidation}</p>
              )}
              {error && (
                <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                A obra so sera criada depois da confirmacao da importacao. Se cancelar agora, nenhum registro vazio sera salvo.
              </p>
            </div>
          </div>
        ) : wizardStep === 1 && (
          <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col items-center justify-start py-2 space-y-3">
            <div
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
              className="w-full border-2 border-dashed border-border rounded-xl p-5 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors cursor-pointer"
              onClick={() => document.getElementById('synthetic-file-input')?.click()}
            >
              {loading ? (
                <Loader2 className="w-10 h-10 text-primary animate-spin" />
              ) : (
                <>
                  <FileSpreadsheet className="w-8 h-8 text-success/70" />
                  <p className="text-sm font-medium text-foreground">1. Sintetica do orcamento - arraste e solte ou clique</p>
                  <p className="text-xs text-muted-foreground">.xlsx · .xls</p>
                </>
              )}
            </div>
            <input
              id="synthetic-file-input"
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
            {error && (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2 w-full">
                <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                <p className="text-xs text-destructive">{error}</p>
              </div>
            )}

            {syntheticConfigPanel}

            {/* Bloco para importar SOMENTE a Analítica, vinculando à Sintética já salva no projeto. */}
            {hasExistingSynthetic && (
              <div className="w-full border-t border-border pt-4 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Ja existe uma Sintetica importada neste projeto. Voce pode anexar somente a <strong>Analitica do contrato</strong> para alimentar insumos, produtividade e Lista de Material - sem reimportar a Sintetica.
                </p>
                <div
                  onDrop={handleAnalyticDrop}
                  onDragOver={e => e.preventDefault()}
                  className="w-full border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center gap-2 hover:border-warning/50 hover:bg-warning/5 transition-colors cursor-pointer"
                  onClick={() => document.getElementById('analytic-only-file-input')?.click()}
                >
                  {analyticLoading ? (
                    <Loader2 className="w-7 h-7 text-warning animate-spin" />
                  ) : (
                    <>
                      <Layers className="w-7 h-7 text-warning/70" />
                      <p className="text-xs font-medium text-foreground">2. Analitica do contrato - arraste e solte ou clique</p>
                      <p className="text-[10px] text-muted-foreground">.xlsx · .xls</p>
                    </>
                  )}
                </div>
                <input
                  id="analytic-only-file-input"
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={e => e.target.files?.[0] && handleAnalyticFile(e.target.files[0])}
                />
                {analyticInfo && (
                  <div className={`rounded-lg border px-3 py-2 text-xs ${
                    analyticOk
                      ? 'border-success/30 bg-success/5 text-success'
                      : 'border-warning/30 bg-warning/5 text-warning'
                  }`}>
                    {analyticFileName && <span className="opacity-70">📄 {analyticFileName} — </span>}
                    {analyticInfo}
                  </div>
                )}
                {analyticConfigPanel}
              </div>
            )}
          </div>
        )}

        {(parsed || hasExistingSynthetic) && wizardStep > 1 && (
          <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
            <div className="flex items-center justify-between flex-wrap gap-2 px-1">
              <span className="text-xs text-muted-foreground">📄 {fileName}</span>
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary font-bold">
                  {reviewBudgetItems.length} itens
                </span>
                <span className="px-2 py-0.5 rounded-full bg-info/15 text-info font-medium flex items-center gap-1">
                  <Info className="w-3 h-3" /> BDI: informado manualmente no contrato
                </span>
              </div>
            </div>

            {/* Bloco da Analítica: anexar arquivo separado caso não esteja no mesmo arquivo. */}
            {error && (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            {isCreateMode && parsed && wizardStep === 2 && missingAnalyticItems.length > 0 && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                <p className="font-semibold">A criação está bloqueada até vincular a Analítica de todos os serviços.</p>
                <p className="mt-1">{missingAnalyticItems.length} serviço(s) sem composição ou sem insumos:</p>
                <ul className="mt-2 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-4">
                  {missingAnalyticItems.slice(0, 20).map(item => (
                    <li key={`${item.item}-${item.code}`}>
                      {item.item} · {item.code} — {item.description} ({item.reason})
                    </li>
                  ))}
                  {missingAnalyticItems.length > 20 && <li>… e mais {missingAnalyticItems.length - 20} serviço(s).</li>}
                </ul>
              </div>
            )}

            {Boolean((globalThis as { __legacySyntheticReview?: boolean }).__legacySyntheticReview) && preview && wizardStep === 2 && (
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-xs font-semibold text-foreground">Configuracao da leitura A-J</div>
                    <div className="text-[11px] text-muted-foreground">Ajuste as colunas conforme a planilha antes de confirmar.</div>
                  </div>
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" onClick={reprocessSynthetic}>
                    Atualizar leitura
                  </Button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <label className="text-[11px] text-muted-foreground">
                    Linha do cabecalho
                    <input type="number" min={1} value={headerRow} onChange={e => setHeaderRow(Number(e.target.value) || 1)} className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground" />
                  </label>
                  <label className="text-[11px] text-muted-foreground">
                    Primeira linha de dados
                    <input type="number" min={1} value={firstDataRow} onChange={e => setFirstDataRow(Number(e.target.value) || 1)} className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground" />
                  </label>
                  <label className="text-[11px] text-muted-foreground">
                    BDI manual (%)
                    <input value={bdiInput} onChange={e => { setBdiInput(e.target.value); setContractField('bdiPercent', e.target.value); }} placeholder="Ex.: 22,50" className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground" />
                  </label>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  {COLUMN_LETTERS.map((letter, index) => (
                    <label key={letter} className="text-[11px] text-muted-foreground">
                      Coluna {letter}
                      <select
                        value={columnRoles[index]}
                        onChange={e => {
                          const next = [...columnRoles];
                          next[index] = e.target.value as SyntheticColumnRole;
                          setColumnRoles(next);
                        }}
                        className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground"
                      >
                        {(Object.keys(ROLE_LABELS) as SyntheticColumnRole[]).map(role => (
                          <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>

                <div className="overflow-x-auto rounded border border-border bg-background">
                  <table className="w-full min-w-[760px] text-[10px]">
                    <thead className="bg-muted">
                      <tr>
                        <th className="px-2 py-1 text-left font-semibold">Linha</th>
                        {COLUMN_LETTERS.map(letter => <th key={letter} className="px-2 py-1 text-left font-semibold">{letter}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice(Math.max(0, headerRow - 2), Math.max(0, headerRow - 2) + 6).map((row, idx) => {
                        const line = Math.max(0, headerRow - 2) + idx + 1;
                        return (
                          <tr key={line} className={line === headerRow ? 'border-t border-border bg-primary/5' : 'border-t border-border'}>
                            <td className="px-2 py-1 font-mono text-muted-foreground">{line}</td>
                            {COLUMN_LETTERS.map((_, col) => (
                              <td key={col} className="px-2 py-1 max-w-[160px] truncate" title={row[col]}>{row[col]}</td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {wizardStep === 2 && (
            <div className="space-y-3">
              <div
                onDrop={handleAnalyticDrop}
                onDragOver={e => e.preventDefault()}
                onClick={() => document.getElementById('analytic-extra-file-input')?.click()}
                className="mx-auto w-full max-w-3xl rounded-xl border-2 border-dashed border-border bg-muted/20 p-8 flex flex-col items-center justify-center gap-3 text-center cursor-pointer hover:border-warning/50 hover:bg-warning/5 transition-colors"
              >
                {analyticLoading ? (
                  <Loader2 className="w-9 h-9 text-warning animate-spin" />
                ) : (
                  <>
                    <Layers className="w-9 h-9 text-warning/80" />
                    <div>
                      <p className="text-sm font-semibold text-foreground">2. Anexar planilha analitica</p>
                      <p className="text-xs text-muted-foreground">Arraste e solte ou clique para selecionar .xlsx / .xls</p>
                    </div>
                  </>
                )}
                <input
                  id="analytic-extra-file-input"
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={e => e.target.files?.[0] && handleAnalyticFile(e.target.files[0])}
                />
              </div>
              {analyticInfo && (
                <div className={`rounded-md border px-2 py-1.5 text-[11px] ${
                  analyticOk
                    ? 'border-success/30 bg-success/5 text-success'
                    : 'border-warning/30 bg-warning/5 text-warning'
                }`}>
                  {analyticFileName && <span className="opacity-70">📄 {analyticFileName} — </span>}
                  {analyticInfo}
                </div>
              )}
              {analyticConfigPanel}
            </div>
            )}

            {wizardStep === 3 && analyticConfigPanel}

            {wizardStep === 4 && (
            <div className="space-y-3">
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
              <div className="text-sm font-semibold text-foreground">4. Revisar integracao das planilhas</div>
              <p className="mt-1 text-xs text-muted-foreground">
                A integracao cria a EAP com os capitulos e subcapitulos importados da Sintetica. Medicao, Aditivo e Custo Real usam a base financeira. Cronograma e Producao recebem somente a RUP formada pelos insumos classificados como Mao de obra.
              </p>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-[10px] uppercase text-muted-foreground font-semibold">Composicoes</p>
                <p className="text-sm font-bold text-foreground mt-0.5">{reviewBudgetItems.length}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-[10px] uppercase text-muted-foreground font-semibold">Analiticas vinculadas</p>
                <p className="text-sm font-bold text-foreground mt-0.5">{analyticCompositions?.length ?? 0}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-[10px] uppercase text-muted-foreground font-semibold">Insumos agrupados</p>
                <p className="text-sm font-bold text-foreground mt-0.5">{analyticInputGroups.length}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-[10px] uppercase text-muted-foreground font-semibold">Mao de obra</p>
                <p className="text-sm font-bold text-success mt-0.5">{analyticClassCounts?.labor ?? 0}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-[10px] uppercase text-muted-foreground font-semibold">Total s/ BDI</p>
                <p className="text-sm font-bold text-foreground mt-0.5">{fmtBRL(totalNoBDI)}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-[10px] uppercase text-muted-foreground font-semibold">Total c/ BDI</p>
                <p className="text-sm font-bold text-success mt-0.5">{fmtBRL(totalWithBDI)}</p>
              </div>
            </div>
            </div>
            )}

            {wizardStep === 4 && (parsed?.groups ?? []).some(group => group.requiresDescription) && (
              <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-warning" />
                  <span className="text-xs font-bold text-warning">Descricoes estruturais obrigatorias</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  A hierarquia foi preservada, mas a planilha deixou estes capitulos ou subcapitulos sem nome. Informe a descricao para concluir.
                </p>
                {(parsed?.groups ?? []).filter(group => group.requiresDescription).map(group => (
                  <div key={group.code} className="grid grid-cols-[7rem_1fr] items-center gap-2">
                    <span className="text-xs font-mono font-semibold">{group.code}</span>
                    <Input
                      value={structuralNames[group.code] ?? ''}
                      onChange={event => setStructuralNames(current => ({ ...current, [group.code]: event.target.value }))}
                      placeholder={`Descricao do ${group.kind === 'chapter' ? 'capitulo' : 'subcapitulo'} ${group.code}`}
                    />
                  </div>
                ))}
              </div>
            )}

            {wizardStep === 4 && (parsed?.errors?.length ?? 0) > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 max-h-40 overflow-y-auto">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                  <span className="text-xs font-bold text-destructive">{parsed?.errors.length} erros bloqueiam a importacao</span>
                </div>
                <ul className="text-[10px] text-muted-foreground space-y-0.5">
                  {parsed?.errors.slice(0, 12).map((message, index) => <li key={index}>• {message}</li>)}
                </ul>
              </div>
            )}

            {wizardStep === 4 && (parsed?.warnings?.length ?? 0) > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 max-h-32 overflow-y-auto">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-warning" />
                  <span className="text-xs font-bold text-warning">{parsed?.warnings.length} avisos</span>
                </div>
                <ul className="text-[10px] text-muted-foreground space-y-0.5">
                  {parsed?.warnings.slice(0, 8).map((w, i) => <li key={i}>• {w}</li>)}
                  {(parsed?.warnings.length ?? 0) > 8 && <li>... e mais {(parsed?.warnings.length ?? 0) - 8}</li>}
                </ul>
              </div>
            )}

            {wizardStep === 4 && (
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-semibold">Item</th>
                      <th className="px-2 py-1.5 text-left font-semibold">Código</th>
                      <th className="px-2 py-1.5 text-left font-semibold">Descrição</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Quant.</th>
                      <th className="px-2 py-1.5 text-left font-semibold">Und</th>
                      <th className="px-2 py-1.5 text-right font-semibold">V.unit c/BDI</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Total c/BDI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewBudgetItems.slice(0, 50).map(it => (
                      <tr key={it.id} className="border-t border-border">
                        <td className="px-2 py-1">{it.item}</td>
                        <td className="px-2 py-1 font-mono">{it.code}</td>
                        <td className="px-2 py-1 truncate max-w-xs" title={it.description}>{it.description}</td>
                        <td className="px-2 py-1 text-right">{it.quantity.toLocaleString('pt-BR')}</td>
                        <td className="px-2 py-1">{it.unit}</td>
                        <td className="px-2 py-1 text-right">{fmtBRL(it.unitPriceWithBDI)}</td>
                        <td className="px-2 py-1 text-right font-medium">{fmtBRL(it.totalWithBDI)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {reviewBudgetItems.length > 50 && (
                  <p className="text-[10px] text-muted-foreground text-center py-2">
                    Mostrando 50 de {reviewBudgetItems.length} itens.
                  </p>
                )}
              </div>
            </div>
            )}

            {wizardStep === 5 && contractDataPanel}
          </div>
        )}

        <DialogFooter className="shrink-0 border-t border-border pt-3">
          <Button variant="outline" onClick={handleClose} disabled={savingImport}>Cancelar</Button>
          {isCreateMode && creationStep === 'name' ? (
            <Button onClick={continueFromProjectName} disabled={!canContinueProjectName}>
              Continuar
            </Button>
          ) : (
          <>
          {isCreateMode && (
            <Button variant="outline" onClick={() => setCreationStep('name')} disabled={savingImport}>
              Voltar ao nome
            </Button>
          )}
          {wizardStep > 1 && (
            <Button variant="outline" onClick={goPreviousStep}>
              Voltar
            </Button>
          )}
          {wizardStep < 5 ? (
            <Button onClick={goNextStep} disabled={!canGoNext}>
              {wizardStep === 1 ? 'Ir para Analitica' : wizardStep === 2 ? 'Ir para classificacao' : wizardStep === 3 ? 'Ir para revisao' : 'Ir para dados iniciais'}
            </Button>
          ) : (
            <Button onClick={confirmImport} disabled={!canGoNext || savingImport || !!(isCreateMode && parsed && !newWorkImportValidation?.isValid)}>
              {savingImport ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Check className="w-4 h-4 mr-1" />}
              {isCreateMode ? 'Concluir importacao' : 'Salvar dados e integrar'}
            </Button>
          )}
          </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
