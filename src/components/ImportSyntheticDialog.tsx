import { useCallback, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
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
  DEFAULT_ANALYTIC_COLUMN_MAP,
  inspectAnalyticWorkbook,
  AnalyticColumnRole,
  AnalyticWorkbookPreview,
} from '@/lib/additiveImport';
import {
  FileSpreadsheet, AlertTriangle, Loader2, Check, Info, DollarSign, Layers,
} from 'lucide-react';
import { guessMaterialCostClass, linkKeyOf, MATERIAL_COST_CLASS_LABEL } from '@/lib/materialComparisons';
import { calculateRupDuration } from '@/lib/calculations';

interface Props {
  open: boolean;
  onClose: () => void;
  project: Project;
  onProjectChange: (project: Project) => void;
}

const fmtBRL = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

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
  'unitPriceWithBDI',
  'totalWithBDI',
  'ignore',
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

  return hits >= 4 ? detected : roles;
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
  const normalized = value.replace('%', '').replace(/\./g, '').replace(',', '.').trim();
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
  return normalizeBudgetItemNumber(budgetItemNumber(a)) === normalizeBudgetItemNumber(budgetItemNumber(b))
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
    bottleneckRole: calc.bottleneckRole,
  };
}

function integrateImportedBudget(project: Project, budgetItems: BudgetItem[], analyticCompositions: AdditiveComposition[]) {
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
    const existingTaskIndex = phases[phaseIndex].tasks.findIndex(t => t.id === nextTask.id || sameBudgetKey({ item: t.contractOrder != null ? item.item : undefined, code: t.itemCode }, item));
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
      item: composition.item || budget?.item,
      itemNumber: composition.itemNumber || budget?.item,
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

export default function ImportSyntheticDialog({ open, onClose, project, onProjectChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedSynthetic | null>(null);
  const [syntheticBuffer, setSyntheticBuffer] = useState<ArrayBuffer | null>(null);
  const [preview, setPreview] = useState<SyntheticWorkbookPreview | null>(null);
  const [columnRoles, setColumnRoles] = useState<SyntheticColumnRole[]>(DEFAULT_COLUMN_ROLES);
  const [headerRow, setHeaderRow] = useState(9);
  const [firstDataRow, setFirstDataRow] = useState(10);
  const [bdiInput, setBdiInput] = useState('');
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4>(1);

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

  const reset = () => {
    setLoading(false);
    setError('');
    setFileName('');
    setParsed(null);
    setSyntheticBuffer(null);
    setPreview(null);
    setColumnRoles(DEFAULT_COLUMN_ROLES);
    setHeaderRow(9);
    setFirstDataRow(10);
    setBdiInput('');
    setWizardStep(1);
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
  };
  const handleClose = () => { reset(); onClose(); };

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError('');
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const inspected = inspectSyntheticWorkbook(buf);
      const detectedBdi = inspected.detectedBdiPercent;
      const nextHeaderRow = inspected.suggestedHeaderRowIndex + 1;
      const nextFirstDataRow = nextHeaderRow + 1;
      const detectedRoles = detectSyntheticColumnRoles(inspected.rows, inspected.suggestedHeaderRowIndex);
      setSyntheticBuffer(buf);
      setPreview(inspected);
      setColumnRoles(detectedRoles);
      setHeaderRow(nextHeaderRow);
      setFirstDataRow(nextFirstDataRow);
      setBdiInput(detectedBdi ? String(detectedBdi).replace('.', ',') : '');
      const result = parseSyntheticBudgetFlexible(buf, {
        sheetName: inspected.sheetName,
        headerRowIndex: inspected.suggestedHeaderRowIndex,
        firstDataRowIndex: inspected.suggestedHeaderRowIndex + 1,
        columns: rolesToMap(detectedRoles),
        bdiPercent: detectedBdi,
      });
      if (result.items.length === 0) {
        setError('Nenhum item financeiro encontrado na planilha Sintética.');
        setLoading(false);
        return;
      }
      setParsed(result);
      setWizardStep(1);

      // Tenta extrair a Analítica do MESMO arquivo (aba Analítica).
      // Falha silenciosa: se não houver, segue só com a Sintética.
      try {
        const an = await extractBaseAnalyticCompositions(buf);
        if (an.hasAnalyticSheet && an.compositions.length > 0) {
          setAnalyticCompositions(classifyAnalyticCompositions(an.compositions));
          setAnalyticOk(true);
          setAnalyticInfo(`Analitica detectada no mesmo arquivo: ${an.compositions.length} composicoes c/ insumos (${an.totalInputs} insumos).`);
        } else {
          setAnalyticCompositions(null);
          setAnalyticOk(false);
          setAnalyticInfo('Aba Analítica não encontrada neste arquivo — você pode anexá-la abaixo.');
        }
      } catch (err: any) {
        setAnalyticCompositions(null);
        setAnalyticOk(false);
        setAnalyticInfo(`Falha ao ler Analítica deste arquivo: ${err?.message ?? 'erro desconhecido'}.`);
      }
    } catch (e: any) {
      setError(`Erro ao ler a Sintética: ${e?.message ?? 'formato não reconhecido'}`);
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
        setAnalyticOk(true);
        setAnalyticCompositions(classifyAnalyticCompositions(an.compositions));
        setAnalyticInfo(an.message);
        setShowAnalyticClassReview(true);
        setWizardStep(3);
      }
    } catch (err: any) {
      setAnalyticOk(false);
      setAnalyticCompositions(null);
      setAnalyticInfo(`Falha ao ler Analítica: ${err?.message ?? 'erro desconhecido'}.`);
    }
    setAnalyticLoading(false);
  }, [parsed, project.budgetItems]);

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

  const reprocessSynthetic = useCallback(() => {
    if (!syntheticBuffer || !preview) return;
    setError('');
    const result = parseSyntheticBudgetFlexible(syntheticBuffer, {
      sheetName: preview.sheetName,
      headerRowIndex: Math.max(0, headerRow - 1),
      firstDataRowIndex: Math.max(0, firstDataRow - 1),
      columns: rolesToMap(columnRoles),
      bdiPercent: parseBdiInput(bdiInput),
    });
    if (result.items.length === 0) {
      setError('Nenhum item financeiro encontrado com esta configuracao de colunas.');
      setParsed(null);
      return;
    }
    setParsed(result);
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
        setAnalyticOk(true);
        setAnalyticCompositions(classifyAnalyticCompositions(an.compositions));
        setAnalyticInfo(an.message);
        setWizardStep(3);
      }
    } catch (err: any) {
      setAnalyticOk(false);
      setAnalyticCompositions(null);
      setAnalyticInfo(`Falha ao ler Analitica: ${err?.message ?? 'erro desconhecido'}.`);
    }
    setAnalyticLoading(false);
  }, [analyticBuffer, analyticPreview, analyticHeaderRow, analyticFirstDataRow, analyticColumnRoles, parsed, project.budgetItems]);

  const confirmImport = () => {
    // Caso 1: importação completa de Sintética (+ opcional Analítica).
    if (parsed) {
      const keep = (project.budgetItems ?? []).filter(b => b.source !== 'sintetica');
      const importedBudgetItems = parsed.items.map(item => ({ ...item, taskId: item.taskId ?? `budget-${item.id}` }));
      const classified = classifyAnalyticCompositions(analyticCompositions ?? []);
      const integration = integrateImportedBudget(project, importedBudgetItems, classified);
      const next: BudgetItem[] = [...keep, ...integration.budgetItems];
      const nextProject: Project = {
        ...project,
        budgetItems: next,
        phases: integration.phases,
        analyticCompositions: integration.analyticCompositions,
        materialCostClasses: classified.length > 0 ? mergeAnalyticCostClasses(project, classified) : project.materialCostClasses,
        syntheticBdiPercent: parsed.bdiPercent,
        syntheticImportedAt: new Date().toISOString(),
      };
      onProjectChange(nextProject);
      handleClose();
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
      onProjectChange({
        ...project,
        budgetItems: integration
          ? (project.budgetItems ?? []).map(item => item.source === 'sintetica' ? (budgetById.get(item.id) ?? item) : item)
          : project.budgetItems,
        phases: integration?.phases ?? project.phases,
        analyticCompositions: integration?.analyticCompositions ?? classified,
        materialCostClasses: mergeAnalyticCostClasses(project, classified),
      });
      handleClose();
      return;
    }
  };

  const reviewBudgetItems = parsed?.items ?? (project.budgetItems ?? []).filter(item => item.source === 'sintetica');
  const totalNoBDI = reviewBudgetItems.reduce((s, i) => s + i.totalNoBDI, 0) ?? 0;
  const totalWithBDI = reviewBudgetItems.reduce((s, i) => s + i.totalWithBDI, 0) ?? 0;
  const hasAnalytic = !!(analyticCompositions && analyticCompositions.length > 0);
  const hasExistingSynthetic = (project.budgetItems ?? []).some(b => b.source === 'sintetica');
  const canGoNext =
    wizardStep === 1 ? !!parsed
    : wizardStep === 2 ? hasAnalytic
    : wizardStep === 3 ? hasAnalytic
    : (!!parsed || hasExistingSynthetic);
  const goNextStep = () => {
    if (wizardStep === 1 && parsed) setWizardStep(2);
    else if (wizardStep === 2 && hasAnalytic) {
      setShowAnalyticClassReview(true);
      setWizardStep(3);
    } else if (wizardStep === 3 && hasAnalytic) setWizardStep(4);
  };
  const goPreviousStep = () => setWizardStep(step => Math.max(1, step - 1) as 1 | 2 | 3 | 4);
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
    ? analyticInputGroups
    : analyticInputGroups.filter(row => row.costClass === analyticClassFilter);
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
  const syntheticConfigPanel = preview ? (
    <div className="w-full rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-xs font-semibold text-foreground">Conferencia da Sintetica A-J</div>
          <div className="text-[11px] text-muted-foreground">Valide as colunas, a primeira linha de dados e o BDI antes de seguir.</div>
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
          <input value={bdiInput} onChange={e => setBdiInput(e.target.value)} placeholder="Ex.: 22,50" className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground" />
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

      {analyticClassSummary && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[11px] font-semibold text-foreground">Classificacao inicial dos insumos</div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => setShowAnalyticClassReview(v => !v)}
            >
              {showAnalyticClassReview ? 'Ocultar validacao' : 'Validar insumos'}
            </Button>
          </div>
          {analyticClassSummary}
          <div className="text-[10px] text-muted-foreground">
            Regra inicial: unidades H, hora e mes entram como mao de obra quando nao houver indicio melhor. A classificacao pode ser revisada na Lista de Material.
          </div>
          {showAnalyticClassReview && (
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
                      <th className="px-2 py-1 text-center font-semibold">Und</th>
                      <th className="px-2 py-1 text-right font-semibold">Qtd. total</th>
                      <th className="px-2 py-1 text-right font-semibold">V. unit. ref.</th>
                      <th className="px-2 py-1 text-right font-semibold">Total ref.</th>
                      <th className="px-2 py-1 text-center font-semibold">Composicoes</th>
                      <th className="px-2 py-1 text-left font-semibold">Classificacao</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAnalyticInputGroups.map(group => (
                      <tr key={group.key} className="border-t border-border">
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
                            onChange={e => updateAnalyticInputGroupClass(group.key, e.target.value as MaterialCostClass)}
                            className="h-7 w-full rounded border border-border bg-background px-2 text-[10px] text-foreground"
                          >
                            {COST_CLASS_OPTIONS.map(option => (
                              <option key={option} value={option}>{MATERIAL_COST_CLASS_LABEL[option]}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
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
    </div>
  ) : null;

  return (
    <Dialog open={open} onOpenChange={v => !v && handleClose()}>
      <DialogContent className="w-[96vw] max-w-7xl max-h-[96vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <DollarSign className="w-5 h-5 text-primary" />
            Iniciar importacao do orcamento
          </DialogTitle>
          <DialogDescription>
            Fluxo unico: importe a Sintetica para formar a base de Medicao, Aditivo, EAP, Cronograma e Custo Real; depois anexe a Analitica para preencher insumos, mao de obra e produtividade.
            A plataforma tenta detectar cabecalhos automaticamente, mas voce pode alterar coluna, linha inicial e BDI antes de confirmar.
            <br />A mescla entre Sintetica e Analitica e feita principalmente por <strong>Item + Codigo</strong>, independentemente do nome usado no cabecalho.
          </DialogDescription>
          <div className="grid grid-cols-4 gap-2 pt-2">
            {[
              { step: 1, label: 'Sintetica', done: !!parsed },
              { step: 2, label: 'Analitica', done: hasAnalytic },
              { step: 3, label: 'Classificar insumos', done: hasAnalytic },
              { step: 4, label: 'Integrar projeto', done: false },
            ].map(item => (
              <div
                key={item.step}
                className={`rounded-lg border px-3 py-2 text-[11px] ${
                  wizardStep === item.step
                    ? 'border-primary bg-primary/10 text-primary'
                    : item.done
                      ? 'border-success/30 bg-success/5 text-success'
                      : 'border-border bg-muted/20 text-muted-foreground'
                }`}
              >
                <div className="font-semibold">{item.step}o passo</div>
                <div className="truncate">{item.label}</div>
              </div>
            ))}
          </div>
        </DialogHeader>

        {wizardStep === 1 && (
          <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col items-center justify-start py-4 space-y-4">
            <div
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
              className="w-full border-2 border-dashed border-border rounded-xl p-10 flex flex-col items-center gap-3 hover:border-primary/50 hover:bg-primary/5 transition-colors cursor-pointer"
              onClick={() => document.getElementById('synthetic-file-input')?.click()}
            >
              {loading ? (
                <Loader2 className="w-10 h-10 text-primary animate-spin" />
              ) : (
                <>
                  <FileSpreadsheet className="w-10 h-10 text-success/70" />
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
          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            <div className="flex items-center justify-between flex-wrap gap-2 px-1">
              <span className="text-xs text-muted-foreground">📄 {fileName}</span>
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary font-bold">
                  {reviewBudgetItems.length} itens
                </span>
                <span className="px-2 py-0.5 rounded-full bg-info/15 text-info font-medium flex items-center gap-1">
                  <Info className="w-3 h-3" /> BDI: {parsed?.bdiPercent ? `${parsed.bdiPercent.toFixed(2)}%` : 'não detectado'}
                </span>
              </div>
            </div>

            {/* Bloco da Analítica: anexar arquivo separado caso não esteja no mesmo arquivo. */}
            {false && preview && wizardStep === 2 && (
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
                    <input value={bdiInput} onChange={e => setBdiInput(e.target.value)} placeholder="Ex.: 22,50" className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground" />
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
            <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <Layers className="w-4 h-4 text-warning" />
                  2. Analitica do contrato
                </div>
                <button
                  type="button"
                  onClick={() => document.getElementById('analytic-extra-file-input')?.click()}
                  className="text-xs px-2 py-1 rounded border border-border bg-card hover:bg-muted transition-colors"
                >
                  {analyticLoading ? 'Lendo...' : 'Anexar Analitica'}
                </button>
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
              {!analyticInfo && (
                <p className="text-[11px] text-muted-foreground">
                  Se a Analitica nao estiver no mesmo arquivo da Sintetica, anexe aqui para alimentar insumos, produtividade, Lista de Material e Custo Real.
                </p>
              )}
            </div>
            )}

            {wizardStep === 3 && analyticConfigPanel}

            {wizardStep === 4 && (
            <div className="space-y-3">
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
              <div className="text-sm font-semibold text-foreground">4. Integrar planilhas ao projeto</div>
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
          </div>
        )}

        <DialogFooter className="shrink-0 border-t border-border pt-3">
          <Button variant="outline" onClick={handleClose}>Cancelar</Button>
          {wizardStep > 1 && (
            <Button variant="outline" onClick={goPreviousStep}>
              Voltar
            </Button>
          )}
          {wizardStep < 4 ? (
            <Button onClick={goNextStep} disabled={!canGoNext}>
              {wizardStep === 1 ? 'Ir para Analitica' : wizardStep === 2 ? 'Ir para classificacao' : 'Ir para integracao'}
            </Button>
          ) : (
            <Button onClick={confirmImport} disabled={!canGoNext}>
              <Check className="w-4 h-4 mr-1" />
              Integrar projeto
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
