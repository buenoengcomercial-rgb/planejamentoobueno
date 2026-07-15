import { Task, LaborComposition } from '@/types/project';
import * as XLSX from 'xlsx';

export interface ParsedLabor {
  role: string;
  unit: string;
  rup: number;
  hours: number;
  days: number;
  workerCount: number;
}

export type IssueLevel = 'error' | 'warning' | 'info';

export interface ImportIssue {
  level: IssueLevel;
  line?: number;
  code?: string;
  bank?: string;
  type?: string;
  description?: string;
  message: string;
  suggestion?: string;
  /** Stable key to associate the issue with a composition in the preview */
  compKey?: string;
}

export interface ParsedComposition {
  code: string;
  bank?: string;
  name: string;
  unit: string;
  quantity: number;
  unitPriceNoBDI?: number;
  labor: ParsedLabor[];
  needsReview: boolean;
  reviewReason?: string;
  /** Source row in the spreadsheet (1-indexed) */
  sourceLine?: number;
  /** Issues attached directly to this composition */
  issues?: ImportIssue[];
}

export interface ParsedChapter {
  code: string;
  name: string;
  children: ParsedChapter[];
  compositions: ParsedComposition[];
  /** Source row in the spreadsheet (1-indexed) */
  sourceLine?: number;
  /** Type as detected ("Capítulo" / "Subcapítulo") */
  kind?: 'chapter' | 'subchapter';
}

export interface ImportSummary {
  chapters: number;
  subchapters: number;
  compositions: number;
  selectedCompositions: number;
  labors: number;
  errors: number;
  warnings: number;
  withPrice: number;
  withoutPrice: number;
}

export interface ParseResult {
  chapters: ParsedChapter[];
  flatCompositions: ParsedComposition[];
  warnings: string[];
  issues: ImportIssue[];
}

// ─── Excel structured parsing (column-based rules) ────────────
export function parseStructuredExcel(data: ArrayBuffer): ParseResult {
  const wb = XLSX.read(data, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  const warnings: string[] = [];
  const issues: ImportIssue[] = [];
  const rootChapters: ParsedChapter[] = [];
  const flatCompositions: ParsedComposition[] = [];

  const pushIssue = (issue: ImportIssue) => {
    issues.push(issue);
    if (issue.level !== 'info') warnings.push(`Linha ${issue.line ?? '?'}: ${issue.message}`);
  };

  // Sequential trackers (Tipo column drives hierarchy)
  const codeToChapter = new Map<string, ParsedChapter>();
  let currentChapter: ParsedChapter | null = null;
  let currentSubchapter: ParsedChapter | null = null;
  let currentComposition: ParsedComposition | null = null;
  let sawAnyChapter = false;

  // Detect header row + dynamic column indices
  const { startRow, cols } = detectHeaderAndColumns(rows);

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const lineNo = i + 1;
    const code = cellStr(row[cols.code]);
    const bank = cellStr(row[cols.bank]);
    const type = cellStr(row[cols.type]);
    const description = cellStr(row[cols.description]);
    const unit = cellStr(row[cols.unit]);
    const quantity = cellNum(row[cols.quantity]);
    const productivity = cellNum(row[cols.productivity]);
    const unitPriceNoBDI = 0; // Produtividade não importa preço
    const rawHours = row[cols.hours];
    const rawDays = row[cols.days];
    const hoursPresent = rawHours !== undefined && rawHours !== null && String(rawHours).trim() !== '';
    const daysPresent = rawDays !== undefined && rawDays !== null && String(rawDays).trim() !== '';
    let hours = cellNum(rawHours);
    let days = cellNum(rawDays);
    // Se Dias estiver vazio mas Horas existir → calcula dias = horas / 8
    if (!daysPresent && hours > 0) days = hours / 8;
    // Se Horas estiver vazio mas Dias existir → calcula horas = dias * 8
    if (!hoursPresent && days > 0) hours = days * 8;

    const hasD = description !== '' || unit !== '';
    const hasE = quantity > 0;
    const hasF = productivity > 0;
    const hasG = hours > 0;
    const hasH = days > 0;
    const hasPrice = unitPriceNoBDI > 0;

    // Skip completely empty rows
    const desc = description || type || code;
    if (!desc && !hasD && !hasE && !hasF && !hasG && !hasH && !hasPrice) continue;
    if (!code && !hasD && !hasE && !hasF && !hasG && !hasH && !hasPrice) continue;

    // Type detection (PRIORITY)
    const tipoNorm = normalizeText(type);
    const isTypeCap = tipoNorm === 'capitulo' || tipoNorm === 'cap';
    const isTypeSub = tipoNorm === 'subcapitulo' || tipoNorm === 'subcap';
    const isTypeComp = tipoNorm === 'composicao' || tipoNorm === 'comp' || tipoNorm === 'servico' || tipoNorm === 'atividade';
    const isTypeLabor = tipoNorm === 'mao de obra' || tipoNorm === 'mdo' || tipoNorm === 'recurso' || tipoNorm === 'insumo mao de obra';
    const hasTypeHint = isTypeCap || isTypeSub || isTypeComp || isTypeLabor;

    // ERROR: type column filled with unrecognized value
    if (type && !hasTypeHint) {
      pushIssue({
        level: 'error', line: lineNo, code, type, description,
        message: `Tipo inválido na coluna C: "${type}"`,
        suggestion: 'Use Capítulo, Subcapítulo, Composição ou Mão de Obra na coluna C.',
      });
    }

    const colA = code;
    const colB = type;
    const colC = description;
    const colD = unit;
    const colE = quantity;
    const colF = productivity;
    const colG = hours;
    const colH = days;

    const classifiedAsChapter = hasTypeHint
      ? (isTypeCap || isTypeSub)
      : (!hasD && !hasE && !hasF && !hasG && !hasH && !hasPrice && !!desc);
    const classifiedAsComposition = hasTypeHint ? isTypeComp : (hasD && hasE && !hasF && !hasG && !hasH);
    const classifiedAsLabor = hasTypeHint ? isTypeLabor : (hasD && !hasE && (hasF || hasG || hasH));

    // ── CHAPTER ──
    if (hasTypeHint ? isTypeCap : (classifiedAsChapter && getCodeDepth(colA) === 0)) {
      if (!colA && !desc) continue;
      const chapter: ParsedChapter = {
        code: colA || `cap-${i}`,
        name: (colC || colB || colA).trim(),
        children: [],
        compositions: [],
        sourceLine: lineNo,
        kind: 'chapter',
      };
      rootChapters.push(chapter);
      if (colA) codeToChapter.set(colA, chapter);
      currentChapter = chapter;
      currentSubchapter = null;
      currentComposition = null;
      sawAnyChapter = true;
      continue;
    }

    // ── SUBCHAPTER ──
    if (hasTypeHint ? isTypeSub : (classifiedAsChapter && getCodeDepth(colA) >= 1)) {
      if (!colA && !desc) continue;
      const subchapter: ParsedChapter = {
        code: colA || `sub-${i}`,
        name: (colC || colB || colA).trim(),
        children: [],
        compositions: [],
        sourceLine: lineNo,
        kind: 'subchapter',
      };

      const parentCode = getParentCode(colA);
      const parent = (parentCode && codeToChapter.get(parentCode)) || currentChapter;

      if (parent) {
        parent.children.push(subchapter);
      } else {
        rootChapters.push(subchapter);
        pushIssue({
          level: 'error', line: lineNo, code: colA, type: 'Subcapítulo', description: subchapter.name,
          message: `Subcapítulo "${subchapter.name}" sem capítulo pai (estrutura quebrada).`,
          suggestion: 'Verificar se existe um capítulo acima deste subcapítulo.',
        });
      }

      if (colA) codeToChapter.set(colA, subchapter);
      currentSubchapter = subchapter;
      currentComposition = null;
      continue;
    }

    // ── COMPOSITION ──
    if (classifiedAsComposition) {
      const comp: ParsedComposition = {
        code: colA,
        bank: bank || undefined,
        name: (colC || colB || '').trim(),
        unit: colD || 'un',
        quantity: colE || 1,
        // Tarefas (EAP) NÃO importa valores financeiros — preço fica para a aba Medição (Sintética)
        unitPriceNoBDI: undefined,
        labor: [],
        needsReview: false,
        sourceLine: lineNo,
        issues: [],
      };

      const parentChapter = currentSubchapter || currentChapter;
      if (parentChapter) {
        parentChapter.compositions.push(comp);
      } else {
        const issue: ImportIssue = {
          level: 'error', line: lineNo, code: colA, type: 'Composição', description: comp.name,
          message: 'Composição sem capítulo ou subcapítulo associado.',
          suggestion: 'Adicionar um capítulo acima desta composição na planilha.',
        };
        comp.issues!.push(issue);
        pushIssue(issue);
      }

      // Per-composition validations
      if (!comp.name) {
        const issue: ImportIssue = {
          level: 'error', line: lineNo, code: colA, type: 'Composição',
          message: 'Composição sem descrição.',
          suggestion: 'Preencher coluna D (Resumo) com a descrição da composição.',
        };
        comp.issues!.push(issue); pushIssue(issue);
      }
      if (!hasE) {
        const issue: ImportIssue = {
          level: 'error', line: lineNo, code: colA, type: 'Composição', description: comp.name,
          message: 'Composição sem quantidade.',
          suggestion: 'Preencher coluna F com quantidade.',
        };
        comp.issues!.push(issue); pushIssue(issue);
      }
      // Produtividade não importa preço — validação financeira fica na Sintética/Medição
      if (!colA) {
        const issue: ImportIssue = {
          level: 'warning', line: lineNo, type: 'Composição', description: comp.name,
          message: 'Composição sem código.',
          suggestion: 'Preencher coluna A com o código da composição.',
        };
        comp.issues!.push(issue); pushIssue(issue);
      }
      if (!bank) {
        const issue: ImportIssue = {
          level: 'warning', line: lineNo, code: colA, type: 'Composição', description: comp.name,
          message: 'Composição sem banco.',
          suggestion: 'Preencher coluna B com o banco (SINAPI, SBC, etc.).',
        };
        comp.issues!.push(issue); pushIssue(issue);
      }
      if (!colD) {
        const issue: ImportIssue = {
          level: 'warning', line: lineNo, code: colA, type: 'Composição', description: comp.name,
          message: 'Composição sem unidade.',
          suggestion: 'Preencher coluna E com unidade.',
        };
        comp.issues!.push(issue); pushIssue(issue);
      }

      flatCompositions.push(comp);
      currentComposition = comp;
      continue;
    }

    // ── LABOR ──
    if (classifiedAsLabor) {
      const labor: ParsedLabor = {
        role: (colC || colB || colD).trim(),
        unit: colD,
        rup: colF,
        hours: colG,
        days: colH,
        workerCount: 1,
      };

      if (currentComposition) {
        currentComposition.labor.push(labor);

        if (colF <= 0) {
          const issue: ImportIssue = {
            level: 'warning', line: lineNo, code: colA, type: 'Mão de obra', description: labor.role,
            message: `Coeficiente de produtividade (RUP) zerado para ${labor.role}.`,
            suggestion: 'Preencher coluna G com a produtividade (h/un).',
          };
          currentComposition.issues = currentComposition.issues || [];
          currentComposition.issues.push(issue);
          pushIssue(issue);
        }
        // Só avisa se AMBOS Horas e Dias estiverem ausentes (vazios) na planilha
        if (!hoursPresent && !daysPresent) {
          const issue: ImportIssue = {
            level: 'warning', line: lineNo, code: colA, type: 'Mão de obra', description: labor.role,
            message: `Horas e dias trabalhados ausentes para ${labor.role}.`,
            suggestion: 'Preencher coluna H (Horas) ou I (Dias).',
          };
          currentComposition.issues = currentComposition.issues || [];
          currentComposition.issues.push(issue);
          pushIssue(issue);
        }
      } else {
        pushIssue({
          level: 'error', line: lineNo, code: colA, type: 'Mão de obra', description: labor.role,
          message: `Mão de obra "${labor.role}" sem composição associada (órfã).`,
          suggestion: 'Verificar se existe uma composição acima desta linha.',
        });
      }
      continue;
    }

    // ── Fallback: composition with inline labor ──
    if (desc && hasD && hasE && (hasF || hasG || hasH)) {
      const comp: ParsedComposition = {
        code: colA,
        name: (colC || colB || '').trim(),
        unit: colD,
        quantity: colE,
        labor: [{ role: colB || 'Trabalhador', unit: colD, rup: colF, hours: colG, days: colH, workerCount: 1 }],
        needsReview: false,
        sourceLine: lineNo,
        issues: [],
      };

      const parentChapter = currentSubchapter || currentChapter;
      if (parentChapter) parentChapter.compositions.push(comp);
      flatCompositions.push(comp);
      currentComposition = comp;
      continue;
    }
  }

  // ── Post-validation: composition without labor / RUP ──
  flatCompositions.forEach((comp) => {
    if (comp.labor.length === 0) {
      comp.needsReview = true;
      comp.reviewReason = 'Sem composição analítica (mão de obra)';
      const issue: ImportIssue = {
        level: 'warning', line: comp.sourceLine, code: comp.code, type: 'Composição', description: comp.name,
        message: 'Composição sem RUP/mão de obra.',
        suggestion: 'Verificar coluna G ou adicionar mão de obra abaixo desta composição.',
      };
      comp.issues = comp.issues || [];
      comp.issues.push(issue);
      pushIssue(issue);
    }
    comp.labor.forEach(l => {
      if (l.rup <= 0) {
        comp.needsReview = true;
        comp.reviewReason = (comp.reviewReason ? comp.reviewReason + '; ' : '') + `RUP ausente para ${l.role}`;
      }
    });
  });

  // ── Empty chapters ──
  function checkEmptyChapters(chapters: ParsedChapter[]) {
    for (const ch of chapters) {
      const totalComps = countCompsRec(ch);
      if (totalComps === 0) {
        pushIssue({
          level: 'warning', line: ch.sourceLine, code: ch.code,
          type: ch.kind === 'subchapter' ? 'Subcapítulo' : 'Capítulo',
          description: ch.name,
          message: `${ch.kind === 'subchapter' ? 'Subcapítulo' : 'Capítulo'} sem nenhuma composição dentro.`,
          suggestion: 'Adicionar composições abaixo deste item ou removê-lo.',
        });
      }
      checkEmptyChapters(ch.children);
    }
  }
  checkEmptyChapters(rootChapters);

  // If no chapters detected, create default
  if (rootChapters.length === 0 && flatCompositions.length > 0) {
    rootChapters.push({ code: '1', name: 'Importados', children: [], compositions: flatCompositions, kind: 'chapter' });
  }

  return { chapters: rootChapters, flatCompositions, warnings, issues };
}

function countCompsRec(ch: ParsedChapter): number {
  let n = ch.compositions.length;
  for (const c of ch.children) n += countCompsRec(c);
  return n;
}

// ─── Legacy flat parsing (CSV/simple Excel) ───────────────────
export interface ParsedTask {
  code: string;
  name: string;
  unit: string;
  quantity: number;
  group: string;
  labor: { role: string; rup: number; workerCount: number }[];
  needsReview: boolean;
  reviewReason?: string;
}

export function parseExcel(data: ArrayBuffer): ParsedTask[] {
  const wb = XLSX.read(data, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  if (rows.length < 2) return [];

  const header = rows[0].map((h: any) => String(h ?? '').toLowerCase().trim());

  const colMap = {
    code: findCol(header, ['código', 'codigo', 'cod', 'code', 'id']),
    name: findCol(header, ['descrição', 'descricao', 'description', 'nome', 'name', 'serviço', 'servico', 'tarefa', 'resumo']),
    unit: findCol(header, ['unidade', 'unit', 'und', 'un']),
    quantity: findCol(header, ['quantidade', 'qty', 'qtd', 'quant']),
    role: findCol(header, ['profissional', 'mão de obra', 'mao de obra', 'trabalhador', 'role', 'tipo', 'função', 'funcao']),
    rup: findCol(header, ['rup', 'coeficiente', 'produtividade', 'h/un', 'h/m', 'h/m²', 'h/m2']),
    group: findCol(header, ['grupo', 'group', 'capítulo', 'capitulo', 'fase', 'phase', 'categoria']),
  };

  const taskMap = new Map<string, ParsedTask>();
  let currentGroup = 'Importados';

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const nonEmpty = row.filter((c: any) => c != null && String(c).trim() !== '').length;
    if (nonEmpty === 1 && colMap.name >= 0) {
      const potentialGroup = String(row[colMap.name] ?? row[0] ?? '').trim();
      if (potentialGroup.length > 2 && potentialGroup.length < 80) {
        currentGroup = potentialGroup;
        continue;
      }
    }

    const code = getStr(row, colMap.code) || `IMP-${i}`;
    const name = getStr(row, colMap.name);
    if (!name) continue;

    const unit = getStr(row, colMap.unit) || 'un';
    const qty = getNum(row, colMap.quantity) || 1;
    const role = getStr(row, colMap.role);
    const rup = getNum(row, colMap.rup);
    const group = getStr(row, colMap.group) || currentGroup;

    if (!taskMap.has(code)) {
      taskMap.set(code, { code, name, unit, quantity: qty, group, labor: [], needsReview: false });
    }

    const task = taskMap.get(code)!;
    if (role && rup > 0) {
      const existing = task.labor.find(l => l.role === role);
      if (existing) existing.rup = rup;
      else task.labor.push({ role, rup, workerCount: 1 });
    }

    if (task.labor.length === 0) {
      task.needsReview = true;
      task.reviewReason = 'Sem composição de mão de obra';
    }
  }

  return Array.from(taskMap.values());
}

// ─── PDF text parsing ──────────────────────────────────────────
export async function parsePDF(data: ArrayBuffer): Promise<ParsedTask[]> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item: any) => item.str).join(' ');
    fullText += text + '\n';
  }

  return parseSinapiText(fullText);
}

function parseSinapiText(text: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let currentGroup = 'Importados';
  const lines = text.split(/\n/);

  const compositionPattern = /(\d{4,6})\s*[-–]\s*(.+?)(?:\s*[-–]\s*(.+?))?$/i;
  const laborPattern = /(?:^|\s)(servente|pedreiro|encanador|eletricista|ajudante|bombeiro\s*hidráulico|topógrafo|operador|mestre|carpinteiro|armador|pintor|soldador|serralheiro|vidraceiro|gesseiro|azulejista|ladrilheiro|impermeabilizador|calceteiro|marmorista|montador)[\s:→\-]+(\d+[.,]\d+)\s*(?:h\/?(?:un|m[²³]?|kg|l|vb)?)?/gi;
  const groupPattern = /^(?:cap[ií]tulo|grupo|fase|servi[çc]os?\s+(?:de\s+)?|instala[çc][ãa]o\s+(?:de\s+)?)\s*[:–-]?\s*(.+)/i;
  const uppercaseGroupPattern = /^([A-ZÀÁÂÃÉÊÍÓÔÕÚÇ\s]{5,50})$/;

  let currentTask: ParsedTask | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const groupMatch = line.match(groupPattern);
    if (groupMatch) { currentGroup = cleanGroupName(groupMatch[1]); continue; }
    if (uppercaseGroupPattern.test(line) && !compositionPattern.test(line)) {
      const cleaned = cleanGroupName(line);
      if (cleaned.length >= 4 && cleaned.length <= 50) { currentGroup = cleaned; continue; }
    }

    const compMatch = line.match(compositionPattern);
    if (compMatch) {
      if (currentTask) tasks.push(currentTask);
      const fullName = (compMatch[2] + (compMatch[3] ? ' - ' + compMatch[3] : '')).trim();
      const unitMatch = fullName.match(/\b(m[²³]?|un|kg|l|vb|cj|gl)\b/i);
      currentTask = { code: compMatch[1], name: fullName, unit: unitMatch ? unitMatch[1] : 'un', quantity: 1, group: currentGroup, labor: [], needsReview: false };
      continue;
    }

    let laborMatch;
    laborPattern.lastIndex = 0;
    while ((laborMatch = laborPattern.exec(line)) !== null) {
      const role = capitalizeFirst(laborMatch[1].trim());
      const rup = parseFloat(laborMatch[2].replace(',', '.'));
      if (currentTask && rup > 0) {
        if (!currentTask.labor.find(l => l.role.toLowerCase() === role.toLowerCase())) {
          currentTask.labor.push({ role, rup, workerCount: 1 });
        }
      }
    }

    if (currentTask) {
      const qtyMatch = line.match(/(?:quantidade|qtd\.?|quant\.?)\s*[:=]?\s*(\d+[.,]?\d*)/i);
      if (qtyMatch) currentTask.quantity = parseFloat(qtyMatch[1].replace(',', '.'));
    }
  }

  if (currentTask) tasks.push(currentTask);
  tasks.forEach(t => {
    if (t.labor.length === 0) { t.needsReview = true; t.reviewReason = 'Sem mão de obra identificada'; }
    if (t.quantity <= 0) { t.needsReview = true; t.reviewReason = (t.reviewReason ? t.reviewReason + '; ' : '') + 'Quantidade não identificada'; }
  });

  return tasks;
}

// ─── Convert structured result to project phases (preserves hierarchy via parentId) ──
export function convertStructuredToProject(result: ParseResult, startDate: string) {
  const phases: { id: string; name: string; color: string; tasks: Task[]; parentId?: string; customNumber?: string; order?: number }[] = [];
  const COLORS = [
    'hsl(var(--primary))', 'hsl(var(--info))', 'hsl(var(--warning))',
    'hsl(var(--success))', 'hsl(var(--destructive))', 'hsl(210, 60%, 50%)',
    'hsl(280, 50%, 55%)', 'hsl(160, 50%, 45%)',
  ];

  let dayOffset = 0;
  let colorIdx = 0;
  let phaseSeq = 0;

  function buildTasks(chapter: ParsedChapter): Task[] {
    return chapter.compositions.map(comp => {
      const laborComps: LaborComposition[] = comp.labor.map((l, i) => ({
        id: `lc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${i}`,
        role: l.role,
        rup: l.rup,
        workerCount: l.workerCount,
      }));

      let duration = 5;
      if (laborComps.length > 0 && comp.quantity > 0) {
        let maxH = 0;
        for (const c of laborComps) {
          const eff = (comp.quantity * c.rup) / c.workerCount;
          if (eff > maxH) maxH = eff;
        }
        duration = Math.max(1, Math.ceil(maxH / 8));
      }
      const maxDays = Math.max(0, ...comp.labor.map(l => l.days));
      if (maxDays > 0) duration = Math.ceil(maxDays);

      const taskStart = new Date(startDate);
      taskStart.setDate(taskStart.getDate() + dayOffset);

      const task: Task = {
        id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${phaseSeq}`,
        name: comp.name,
        phase: `[${chapter.code}] ${chapter.name}`,
        startDate: taskStart.toISOString().split('T')[0],
        duration,
        dependencies: [],
        responsible: '',
        percentComplete: 0,
        level: 0,
        quantity: comp.quantity,
        unit: comp.unit,
        itemCode: comp.code || undefined,
        priceBank: comp.bank || undefined,
        unitPriceNoBDI: comp.unitPriceNoBDI,
        laborCompositions: laborComps,
        materials: [],
        observations: comp.code ? `Código: ${comp.code}` : undefined,
      };

      dayOffset += duration;
      return task;
    });
  }

  function processChapter(chapter: ParsedChapter, parentPhaseId: string | undefined, order: number) {
    const phaseId = `phase-${(chapter.code || 'x').replace(/[^A-Za-z0-9]/g, '_')}-${Date.now().toString(36)}-${(phaseSeq++).toString(36)}`;
    const displayName = chapter.name || chapter.code || 'Capítulo';

    phases.push({
      id: phaseId,
      name: displayName,
      color: COLORS[colorIdx % COLORS.length],
      tasks: buildTasks(chapter),
      parentId: parentPhaseId,
      customNumber: chapter.code || undefined,
      order,
    });
    colorIdx++;

    chapter.children.forEach((child, idx) => processChapter(child, phaseId, idx));
  }

  result.chapters.forEach((ch, idx) => processChapter(ch, undefined, idx));

  return phases;
}


// ─── Legacy convert (flat tasks) ──────────────────────────────
export function convertToProjectTasks(parsed: ParsedTask[], startDate: string) {
  const groups = new Map<string, Task[]>();
  const baseDate = new Date(startDate);
  let dayOffset = 0;

  for (const p of parsed) {
    if (!groups.has(p.group)) groups.set(p.group, []);

    const taskStart = new Date(baseDate);
    taskStart.setDate(taskStart.getDate() + dayOffset);

    const laborComps: LaborComposition[] = p.labor.map((l, i) => ({
      id: `lc-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${i}`,
      role: l.role,
      rup: l.rup,
      workerCount: l.workerCount,
    }));

    let duration = 5;
    if (laborComps.length > 0 && p.quantity > 0) {
      let maxH = 0;
      for (const c of laborComps) {
        const eff = (p.quantity * c.rup) / c.workerCount;
        if (eff > maxH) maxH = eff;
      }
      duration = Math.max(1, Math.ceil(maxH / 8));
    }

    const task: Task = {
      id: `t-imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: p.name,
      phase: p.group,
      startDate: taskStart.toISOString().split('T')[0],
      duration,
      dependencies: [],
      responsible: '',
      percentComplete: 0,
      level: 0,
      quantity: p.quantity,
      unit: p.unit,
      laborCompositions: laborComps,
      materials: [],
      observations: p.code ? `Código SINAPI: ${p.code}` : undefined,
    };

    groups.get(p.group)!.push(task);
    dayOffset += duration;
  }

  return { groups };
}

// ─── Standardize SINAPI names ──────────────────────────────────
export function standardizeSinapi(tasks: ParsedTask[]): ParsedTask[] {
  const roleMap: Record<string, string> = {
    'servente': 'Servente', 'pedreiro': 'Pedreiro', 'encanador': 'Encanador',
    'eletricista': 'Eletricista', 'ajudante': 'Ajudante', 'bombeiro hidráulico': 'Bombeiro Hidráulico',
    'topógrafo': 'Topógrafo', 'operador': 'Operador', 'mestre': 'Mestre de Obra',
    'carpinteiro': 'Carpinteiro', 'armador': 'Armador', 'pintor': 'Pintor', 'soldador': 'Soldador',
  };

  const unitMap: Record<string, string> = {
    'm²': 'm²', 'm2': 'm²', 'metro quadrado': 'm²', 'm³': 'm³', 'm3': 'm³', 'metro cúbico': 'm³',
    'm': 'm', 'ml': 'm', 'metro': 'm', 'metro linear': 'm', 'un': 'un', 'und': 'un', 'unid': 'un',
    'unidade': 'un', 'kg': 'kg', 'quilo': 'kg', 'l': 'L', 'litro': 'L', 'vb': 'vb', 'verba': 'vb',
    'cj': 'cj', 'conjunto': 'cj',
  };

  return tasks.map(t => ({
    ...t,
    name: t.name.replace(/\s+/g, ' ').replace(/^\d{4,6}\s*[-–]\s*/, '').trim(),
    unit: unitMap[t.unit.toLowerCase()] || t.unit,
    labor: t.labor.map(l => ({ ...l, role: roleMap[l.role.toLowerCase()] || capitalizeFirst(l.role) })),
  }));
}

// ─── Auto-detect format ───────────────────────────────────────
export function detectExcelFormat(data: ArrayBuffer): 'structured' | 'flat' {
  const wb = XLSX.read(data, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  if (rows.length < 2) return 'flat';

  // 1) If we can locate a header row with Código + Tipo + Resumo → structured
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    if (!row) continue;
    const headerNorm = row.map(c =>
      String(c ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
    );
    const hasCode = headerNorm.some(h => h === 'codigo' || h === 'cod' || h === 'code');
    const hasType = headerNorm.some(h => h === 'tipo' || h === 'type');
    const hasDesc = headerNorm.some(h => h === 'resumo' || h === 'descricao' || h === 'description' || h === 'nome');
    if (hasCode && hasType && hasDesc) return 'structured';
  }

  // 2) Fallback heuristic: chapter-like + labor-like patterns
  let chapterLikeRows = 0;
  let laborLikeRows = 0;
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const hasDesc = row[2] != null && String(row[2]).trim() !== '';
    const hasD = row[3] != null && String(row[3]).trim() !== '';
    const hasE = row[4] != null && parseFloat(String(row[4])) > 0;
    const hasF = row[5] != null && parseFloat(String(row[5])) > 0;
    const hasG = row[6] != null && parseFloat(String(row[6])) > 0;
    const hasH = row[7] != null && parseFloat(String(row[7])) > 0;
    if (hasDesc && !hasD && !hasE && !hasF && !hasG && !hasH) chapterLikeRows++;
    if (hasD && !hasE && (hasF || hasG || hasH)) laborLikeRows++;
  }
  if (chapterLikeRows >= 1 && laborLikeRows >= 1) return 'structured';
  return 'flat';
}

// ─── Helpers ───────────────────────────────────────────────────
interface ColumnMap {
  code: number;
  bank: number;
  type: number;
  description: number;
  unit: number;
  quantity: number;
  productivity: number;
  unitPriceNoBDI: number;
  hours: number;
  days: number;
}

// Layout Produtividade (ArquimedesPRODUTIVIDADE.xlsx):
// A=Código B=Banco C=Tipo D=Resumo E=Ud F=Quant. G=Prod. H=Horas Trabalhadas I=Dias Trabalhados
// NÃO há coluna de preço — valores financeiros vêm da Sintética.
const DEFAULT_COLS: ColumnMap = {
  code: 0, bank: 1, type: 2, description: 3, unit: 4,
  quantity: 5, productivity: 6, unitPriceNoBDI: -1, hours: 7, days: 8,
};

function detectHeaderAndColumns(rows: any[][]): { startRow: number; cols: ColumnMap } {
  // Search for the header row in first 20 rows
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const headerNorm = row.map(c => normalizeText(c));
    const hasCode = headerNorm.some(h => h === 'codigo' || h === 'cod' || h === 'code');
    const hasType = headerNorm.some(h => h === 'tipo' || h === 'type');
    const hasDesc = headerNorm.some(h => h === 'resumo' || h === 'descricao' || h === 'description' || h === 'nome');
    if (hasCode && hasType && hasDesc) {
      const cols: ColumnMap = {
        code: findCol(headerNorm, ['codigo', 'cod', 'code', 'id']),
        bank: findCol(headerNorm, ['banco', 'fonte', 'origem']),
        type: findCol(headerNorm, ['tipo', 'type']),
        description: findCol(headerNorm, ['resumo', 'descricao', 'description', 'nome', 'servico']),
        unit: findCol(headerNorm, ['ud', 'und', 'unidade', 'unit', 'un']),
        quantity: findCol(headerNorm, ['quant', 'qtd', 'quantidade', 'qty']),
        productivity: findCol(headerNorm, ['prod', 'rup', 'coeficiente', 'produtividade']),
        unitPriceNoBDI: findCol(headerNorm, ['preco s/ bdi', 'preco sem bdi', 'preco unit', 'p. unit', 'valor unit', 'preco', 'unit price']),
        hours: findCol(headerNorm, ['horas trabalhadas', 'horas', 'hrs', 'h trab']),
        days: findCol(headerNorm, ['dias trabalhados', 'dias', 'd trab']),
      };
      // Defaults — layout produtividade: A..I (sem coluna de preço)
      if (cols.code < 0) cols.code = 0;
      if (cols.bank < 0) cols.bank = 1;
      if (cols.type < 0) cols.type = 2;
      if (cols.description < 0) cols.description = 3;
      if (cols.unit < 0) cols.unit = 4;
      if (cols.quantity < 0) cols.quantity = 5;
      if (cols.productivity < 0) cols.productivity = 6;
      if (cols.hours < 0) cols.hours = 7;
      if (cols.days < 0) cols.days = 8;
      // EAP/Produtividade NÃO importa preço — ignorar mesmo se a planilha tiver coluna similar
      cols.unitPriceNoBDI = -1;
      return { startRow: i + 1, cols };
    }
  }
  // Fallback: assume legacy 8-column layout, no header row detection
  return { startRow: 0, cols: { ...DEFAULT_COLS } };
}

function normalizeText(value: any): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function safeText(value: any): string {
  return String(value ?? '').trim();
}

function getCodeDepth(code: string): number {
  if (!code) return 0;
  const clean = code.replace(/\s/g, '');
  const parts = clean.split(/[.\-\/]/);
  return Math.max(0, parts.length - 1);
}

function getParentCode(code: string): string | null {
  if (!code) return null;
  const clean = code.replace(/\s/g, '');
  const lastDot = clean.lastIndexOf('.');
  if (lastDot <= 0) return null;
  return clean.substring(0, lastDot);
}

function findParentChapter(code: string, codeMap: Map<string, ParsedChapter>): ParsedChapter | null {
  if (!code) return null;
  let parentCode = getParentCode(code);
  while (parentCode) {
    const parent = codeMap.get(parentCode);
    if (parent) return parent;
    parentCode = getParentCode(parentCode);
  }
  return null;
}

function cellStr(val: any): string {
  if (val == null) return '';
  return String(val).trim();
}

function cellNum(val: any): number {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  const raw = String(val).trim().replace(/\s/g, '');
  if (!raw) return 0;
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;
  return parseFloat(normalized) || 0;
}

function findCol(header: string[], keys: string[]): number {
  for (const key of keys) {
    const idx = header.findIndex(h => String(h ?? '').toLowerCase().includes(key));
    if (idx >= 0) return idx;
  }
  return -1;
}

function getStr(row: any[], col: number): string {
  if (col < 0 || col >= row.length) return '';
  return String(row[col] ?? '').trim();
}

function getNum(row: any[], col: number): number {
  if (col < 0 || col >= row.length) return 0;
  const v = row[col];
  if (typeof v === 'number') return v;
  return parseFloat(String(v ?? '0').replace(',', '.')) || 0;
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function cleanGroupName(s: string): string {
  return s.replace(/[:\-–]+$/, '').replace(/^\d+[\s.)\-]*/, '').trim()
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// ─────────────────────────────────────────────────────────────────
// SINTÉTICA → BudgetItem[] (alimenta a Medição)
// Layout fixo: A=Item B=Código C=Banco D=Descrição E=Quantidade
//              F=Unidade G=Vunit s/BDI H=Total s/BDI I=Vunit c/BDI J=Total c/BDI
// BDI lido de J8 quando presente.
// ─────────────────────────────────────────────────────────────────
import type { BudgetItem } from '@/types/project';

export interface ParsedSynthetic {
  items: BudgetItem[];
  bdiPercent?: number;
  warnings: string[];
}

import { trunc2 as _trunc2, money2 as _money2, calculateUnitPriceWithBDI as _calcUnitWithBDI, calculateLineTotal as _calcLineTotal } from './financialEngine';

export type SyntheticColumnRole =
  | 'ignore'
  | 'item'
  | 'code'
  | 'bank'
  | 'description'
  | 'quantity'
  | 'unit'
  | 'unitPriceNoBDI'
  | 'totalNoBDI'
  | 'unitPriceWithBDI'
  | 'totalWithBDI';

export type SyntheticColumnMap = Partial<Record<Exclude<SyntheticColumnRole, 'ignore'>, number>>;

export interface SyntheticImportOptions {
  sheetName?: string;
  headerRowIndex?: number;
  firstDataRowIndex?: number;
  columns?: SyntheticColumnMap;
  bdiPercent?: number;
}

export interface SyntheticWorkbookPreview {
  sheetNames: string[];
  sheetName: string;
  rows: string[][];
  suggestedHeaderRowIndex: number;
  detectedBdiPercent?: number;
}

export const DEFAULT_SYNTHETIC_COLUMN_MAP: SyntheticColumnMap = {
  item: 0,
  code: 1,
  bank: 2,
  description: 3,
  quantity: 4,
  unit: 5,
  unitPriceNoBDI: 6,
  unitPriceWithBDI: 7,
  totalWithBDI: 8,
};

function _toNumSyn(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[^\d.,\-]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function _str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function _normLow(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function _findSyntheticSheetName(wb: XLSX.WorkBook, sheetName?: string): string {
  if (sheetName && wb.Sheets[sheetName]) return sheetName;
  return wb.SheetNames.find(n => _normLow(n).includes('sintet')) ?? wb.SheetNames[0];
}

function _detectSyntheticBdi(rows: any[][]): number | undefined {
  const j8 = _toNumSyn(rows[7]?.[9]);
  if (j8 > 0 && j8 < 200) return j8;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const r = rows[i] || [];
    for (let c = 0; c < r.length; c++) {
      if (_normLow(_str(r[c])).includes('bdi')) {
        for (let cc = c + 1; cc < r.length; cc++) {
          const n = _toNumSyn(r[cc]);
          if (n > 0 && n < 200) return n;
        }
      }
    }
  }
  return undefined;
}

function _detectSyntheticHeaderIndex(rows: any[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = (rows[i] || []).map(c => _normLow(_str(c))).join(' | ');
    let hits = 0;
    if (joined.includes('item')) hits++;
    if (joined.includes('codigo') || joined.includes('código')) hits++;
    if (joined.includes('descricao') || joined.includes('descrição')) hits++;
    if (joined.includes('unidade') || joined.includes('und') || joined.includes(' un')) hits++;
    if (hits >= 3) return i;
  }
  return 0;
}

export function inspectSyntheticWorkbook(data: ArrayBuffer, sheetName?: string): SyntheticWorkbookPreview {
  const wb = XLSX.read(data, { type: 'array' });
  const selectedSheetName = _findSyntheticSheetName(wb, sheetName);
  const sheet = wb.Sheets[selectedSheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  return {
    sheetNames: wb.SheetNames,
    sheetName: selectedSheetName,
    rows: rows.slice(0, 25).map(row => Array.from({ length: 10 }, (_, i) => _str(row?.[i]))),
    suggestedHeaderRowIndex: _detectSyntheticHeaderIndex(rows),
    detectedBdiPercent: _detectSyntheticBdi(rows),
  };
}

/**
 * Importa a planilha SINTÉTICA do orçamento.
 * Aceita ArrayBuffer (xlsx) e procura aba cujo nome contenha "sintet".
 */
export function parseSyntheticBudget(data: ArrayBuffer, options: SyntheticImportOptions = {}): ParsedSynthetic {
  const wb = XLSX.read(data, { type: 'array' });
  // Procura aba cujo nome contenha "sintet"; senão usa a primeira.
  const sheetName = _findSyntheticSheetName(wb, options.sheetName);
  const sheet = wb.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  const warnings: string[] = [];

  // BDI de J8 (linha 8 / coluna J = índice 9)
  let bdiPercent: number | undefined;
  const j8 = _toNumSyn(rows[7]?.[9]);
  if (j8 > 0 && j8 < 200) {
    bdiPercent = j8;
  } else {
    // Fallback: procura "BDI" nas primeiras linhas
    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      const r = rows[i] || [];
      for (let c = 0; c < r.length; c++) {
        if (_normLow(_str(r[c])).includes('bdi')) {
          for (let cc = c + 1; cc < r.length; cc++) {
            const n = _toNumSyn(r[cc]);
            if (n > 0 && n < 200) { bdiPercent = n; break; }
          }
        }
        if (bdiPercent) break;
      }
      if (bdiPercent) break;
    }
  }

  // Detecta linha de cabeçalho (procura "item", "codigo", "descricao")
  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = (rows[i] || []).map(c => _normLow(_str(c))).join(' | ');
    let hits = 0;
    if (joined.includes('item')) hits++;
    if (joined.includes('codigo') || joined.includes('código')) hits++;
    if (joined.includes('descricao') || joined.includes('descrição')) hits++;
    if (joined.includes('unidade') || joined.includes('und')) hits++;
    if (hits >= 3) { headerIdx = i; break; }
  }

  const items: BudgetItem[] = [];
  const fator = 1 + (bdiPercent ?? 0) / 100;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const item = _str(r[0]);
    const code = _str(r[1]);
    const bank = _str(r[2]);
    const description = _str(r[3]);
    const quantity = _toNumSyn(r[4]);
    const unit = _str(r[5]);
    const upNoBDI = _toNumSyn(r[6]);
    const totalNoBDI = _toNumSyn(r[7]);
    const upWithBDI = _toNumSyn(r[8]);
    const totalWithBDI = _toNumSyn(r[9]);

    if (!item && !code && !description && !quantity && !upNoBDI && !totalNoBDI) continue;
    const dLow = _normLow(description);
    if (!code && (dLow.includes('total') || dLow.includes('subtotal'))) continue;
    if (!bank) continue; // capítulos da sintética não têm banco
    if (!code) continue;

    // Valores que JÁ vêm prontos do Excel: normalizar com money2 (arredondamento seguro).
    // Valores CALCULADOS pelo sistema (quando a coluna está vazia): usar trunc2.
    const finalUpNoBDI = _money2(upNoBDI);
    const finalUpWithBDI = upWithBDI > 0 ? _money2(upWithBDI) : _calcUnitWithBDI(finalUpNoBDI, bdiPercent ?? 0);
    const finalTotalNoBDI = totalNoBDI > 0 ? _money2(totalNoBDI) : _calcLineTotal(finalUpNoBDI, quantity);
    const finalTotalWithBDI = totalWithBDI > 0 ? _money2(totalWithBDI) : _calcLineTotal(finalUpWithBDI, quantity);

    if (quantity <= 0) warnings.push(`Linha ${i + 1} (${code}): quantidade zero/inválida.`);
    if (upNoBDI <= 0) warnings.push(`Linha ${i + 1} (${code}): valor unitário s/ BDI zero/inválido.`);

    items.push({
      id: `bgt-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      item, code, bank, description, unit, quantity,
      unitPriceNoBDI: finalUpNoBDI,
      unitPriceWithBDI: finalUpWithBDI,
      totalNoBDI: finalTotalNoBDI,
      totalWithBDI: finalTotalWithBDI,
      source: 'sintetica',
    });
  }

  return { items, bdiPercent, warnings };
}

export function parseSyntheticBudgetFlexible(data: ArrayBuffer, options: SyntheticImportOptions): ParsedSynthetic {
  const wb = XLSX.read(data, { type: 'array' });
  const sheetName = _findSyntheticSheetName(wb, options.sheetName);
  const sheet = wb.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  const warnings: string[] = [];
  const bdiPercent = options.bdiPercent !== undefined && Number.isFinite(options.bdiPercent)
    ? options.bdiPercent
    : _detectSyntheticBdi(rows);
  const headerIdx = options.headerRowIndex ?? _detectSyntheticHeaderIndex(rows);
  const firstDataRowIndex = options.firstDataRowIndex ?? headerIdx + 1;
  const columns = { ...DEFAULT_SYNTHETIC_COLUMN_MAP, ...(options.columns ?? {}) };
  const read = (row: any[], key: keyof SyntheticColumnMap) => {
    const index = columns[key];
    return typeof index === 'number' ? row[index] : '';
  };
  const items: BudgetItem[] = [];

  for (let i = firstDataRowIndex; i < rows.length; i++) {
    const r = rows[i] || [];
    const item = _str(read(r, 'item'));
    const code = _str(read(r, 'code'));
    const bank = _str(read(r, 'bank'));
    const description = _str(read(r, 'description'));
    const quantity = _toNumSyn(read(r, 'quantity'));
    const unit = _str(read(r, 'unit'));
    const upNoBDI = _toNumSyn(read(r, 'unitPriceNoBDI'));
    const totalNoBDI = _toNumSyn(read(r, 'totalNoBDI'));
    const upWithBDI = _toNumSyn(read(r, 'unitPriceWithBDI'));
    const totalWithBDI = _toNumSyn(read(r, 'totalWithBDI'));

    if (!item && !code && !description && !quantity && !upNoBDI && !totalNoBDI && !upWithBDI && !totalWithBDI) continue;
    const dLow = _normLow(description);
    if (!code && (dLow.includes('total') || dLow.includes('subtotal'))) continue;
    if (!code) continue;

    const bdiFactor = 1 + (bdiPercent ?? 0) / 100;
    const finalUpNoBDI = upNoBDI > 0
      ? _money2(upNoBDI)
      : (upWithBDI > 0 && bdiFactor > 0 ? _money2(upWithBDI / bdiFactor) : 0);
    const finalUpWithBDI = upWithBDI > 0 ? _money2(upWithBDI) : _calcUnitWithBDI(finalUpNoBDI, bdiPercent ?? 0);
    const finalTotalNoBDI = totalNoBDI > 0 ? _money2(totalNoBDI) : _calcLineTotal(finalUpNoBDI, quantity);
    const finalTotalWithBDI = totalWithBDI > 0 ? _money2(totalWithBDI) : _calcLineTotal(finalUpWithBDI, quantity);

    if (quantity <= 0) warnings.push(`Linha ${i + 1} (${code}): quantidade zero/invalida.`);
    if (finalUpNoBDI <= 0 && finalUpWithBDI <= 0) warnings.push(`Linha ${i + 1} (${code}): valor unitario nao encontrado.`);
    if (!bank) warnings.push(`Linha ${i + 1} (${code}): banco nao informado.`);

    items.push({
      id: `bgt-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      item,
      code,
      bank,
      description,
      unit,
      quantity,
      unitPriceNoBDI: finalUpNoBDI,
      unitPriceWithBDI: finalUpWithBDI,
      totalNoBDI: finalTotalNoBDI,
      totalWithBDI: finalTotalWithBDI,
      source: 'sintetica',
    });
  }

  return { items, bdiPercent, warnings };
}
