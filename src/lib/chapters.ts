import { Phase, Project, Task, DependencyType } from '@/types/project';
import { checkDependencyViolation } from '@/lib/calculations';
import { flattenTaskTree } from '@/lib/taskTree';

/**
 * Hierarquia de capítulos
 * --------------------------------------------------------------
 * Cada `Phase` representa um capítulo ou subcapítulo da EAP.
 *  - `parentId` undefined → capítulo principal
 *  - `parentId` string    → subcapítulo daquele capítulo principal
 *
 * As tarefas continuam vivendo dentro de cada Phase. Um capítulo
 * principal NÃO contém tarefas próprias — apenas subcapítulos que
 * contêm as tarefas. Capítulos sem `parentId` e sem filhos também
 * podem conter tarefas (legado / lista plana).
 */

export interface ChapterNode {
  phase: Phase;
  children: ChapterNode[]; // subcapítulos diretos (recursivo)
}

/** Agrupa as phases do projeto em árvore recursiva (N níveis). */
export function getChapterTree(project: Project): ChapterNode[] {
  const phases = [...project.phases];
  const sortFn = (a: Phase, b: Phase) =>
    (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);

  const childrenByParent = new Map<string, Phase[]>();
  phases.forEach(p => {
    const key = p.parentId ?? '__root__';
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key)!.push(p);
  });
  childrenByParent.forEach(arr => arr.sort(sortFn));

  const visited = new Set<string>();
  const buildNode = (phase: Phase): ChapterNode => {
    visited.add(phase.id);
    const childPhases = childrenByParent.get(phase.id) ?? [];
    return {
      phase,
      children: childPhases.filter(c => !visited.has(c.id)).map(buildNode),
    };
  };

  const roots = childrenByParent.get('__root__') ?? [];
  return roots.map(buildNode);
}

/**
 * Achata recursivamente em DFS para que cada capítulo apareça seguido
 * por todos os seus descendentes em ordem de árvore.
 */
export function flattenPhasesByChapter(project: Project): Phase[] {
  const tree = getChapterTree(project);
  const out: Phase[] = [];
  const walk = (node: ChapterNode) => {
    out.push(node.phase);
    node.children.forEach(walk);
  };
  tree.forEach(walk);
  // Inclui phases órfãs (parentId apontando para alguém inexistente)
  const ids = new Set(out.map(p => p.id));
  project.phases.forEach(p => {
    if (!ids.has(p.id)) out.push(p);
  });
  return out;
}

/** Retorna true se a phase é capítulo principal. */
export function isMainChapter(phase: Phase): boolean {
  return !phase.parentId;
}

/** Move uma phase para virar subcapítulo de outra (ou promove a capítulo principal).
 *  Anexa SEMPRE como último filho, recalculando `order` baseado nos irmãos atuais. */
export function moveChapter(
  project: Project,
  chapterId: string,
  newParentId: string | null,
): Project {
  if (chapterId === newParentId) return project;
  if (newParentId && isDescendant(project, newParentId, chapterId)) return project;

  const targetParent = newParentId ?? null;
  const siblings = project.phases.filter(
    p => (p.parentId ?? null) === targetParent && p.id !== chapterId,
  );
  const maxOrder = siblings.reduce(
    (m, s) => Math.max(m, s.order ?? -1),
    -1,
  );
  const newOrder = maxOrder + 1;

  return {
    ...project,
    phases: project.phases.map(p =>
      p.id === chapterId
        ? { ...p, parentId: newParentId ?? undefined, order: newOrder, customNumber: undefined }
        : p,
    ),
  };
}

/** Promove um subcapítulo a capítulo principal (último na lista de raízes). */
export function promoteChapterToRoot(project: Project, chapterId: string): Project {
  return moveChapter(project, chapterId, null);
}

/**
 * Reordena um capítulo dentro do mesmo nível (mesmo parentId).
 * `targetChapterId` define a posição: o capítulo arrastado é inserido
 * imediatamente ANTES do alvo (ou no FINAL se `position === 'after'`).
 * Mantém o `parentId` do alvo (permite mover entre níveis também).
 */
export function reorderChapter(
  project: Project,
  draggedId: string,
  targetId: string,
  position: 'before' | 'after' = 'before',
): Project {
  if (draggedId === targetId) return project;
  const target = project.phases.find(p => p.id === targetId);
  if (!target) return project;
  // Impede ciclo se mudar de pai
  if (target.parentId && isDescendant(project, target.parentId, draggedId)) return project;

  const newParent = target.parentId;
  // Constrói lista de irmãos (já ordenada por order)
  const siblings = project.phases
    .filter(p => (p.parentId ?? null) === (newParent ?? null) && p.id !== draggedId)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

  const targetIdx = siblings.findIndex(s => s.id === targetId);
  const insertAt = position === 'after' ? targetIdx + 1 : targetIdx;
  const draggedPhase = project.phases.find(p => p.id === draggedId);
  if (!draggedPhase) return project;
  const updatedDragged: Phase = { ...draggedPhase, parentId: newParent };
  siblings.splice(insertAt, 0, updatedDragged);

  // Reatribui order sequencial aos irmãos do nível
  const orderMap = new Map<string, number>();
  siblings.forEach((s, i) => orderMap.set(s.id, i));

  return {
    ...project,
    phases: project.phases.map(p => {
      if (p.id === draggedId) return { ...updatedDragged, order: orderMap.get(p.id) ?? p.order };
      if ((p.parentId ?? null) === (newParent ?? null) && orderMap.has(p.id)) {
        return { ...p, order: orderMap.get(p.id)! };
      }
      return p;
    }),
  };
}

/**
 * Reordena um capítulo a partir de um número desejado digitado pelo usuário.
 * - "2" em capítulo principal → move para a 2ª posição entre as raízes.
 * - "1.3" em subcapítulo → move para a 3ª posição entre os irmãos do mesmo pai.
 * - "1.3" digitado num capítulo principal → vira subcapítulo do capítulo "1"
 *   na 3ª posição.
 * - Texto não numérico (ex.: "1A", "Anexo") → preserva como `customNumber`
 *   e não reordena.
 * Sempre limpa `customNumber` quando aplica reordenação numérica para que
 * `getChapterNumbering` reflita imediatamente a nova posição.
 */
export function reorderChapterByNumber(
  project: Project,
  chapterId: string,
  desiredNumber: string,
): Project {
  const raw = (desiredNumber || '').trim();
  if (!raw) {
    // Limpa customNumber
    return {
      ...project,
      phases: project.phases.map(p =>
        p.id === chapterId ? { ...p, customNumber: undefined } : p,
      ),
    };
  }

  const chapter = project.phases.find(p => p.id === chapterId);
  if (!chapter) return project;

  const segments = raw.split('.').map(s => s.trim());
  const allNumeric = segments.every(s => /^\d+$/.test(s) && Number(s) >= 1);

  // Não numérico → mantém apenas como rótulo customizado
  if (!allNumeric) {
    return {
      ...project,
      phases: project.phases.map(p =>
        p.id === chapterId ? { ...p, customNumber: raw } : p,
      ),
    };
  }

  // Determina destino (parentId) e índice (1-based → 0-based)
  let targetParentId: string | undefined;
  let desiredIndex: number;

  if (segments.length === 1) {
    // Capítulo principal
    targetParentId = undefined;
    desiredIndex = Number(segments[0]) - 1;
  } else {
    // Hierárquico: usa primeiro segmento para identificar pai entre as raízes (por número atual)
    const tree = getChapterTree(project);
    const rootIdx = Number(segments[0]) - 1;
    const parentNode = tree[rootIdx];
    if (!parentNode) {
      // Pai inexistente → fallback: trata como capítulo principal usando o último segmento
      targetParentId = undefined;
      desiredIndex = Number(segments[segments.length - 1]) - 1;
    } else {
      targetParentId = parentNode.phase.id;
      desiredIndex = Number(segments[segments.length - 1]) - 1;
    }
  }

  if (desiredIndex < 0) desiredIndex = 0;

  // Impede ciclo se mudar de pai
  if (targetParentId && (targetParentId === chapterId || isDescendant(project, targetParentId, chapterId))) {
    return project;
  }

  // Atualiza parentId do capítulo arrastado
  const movedChapter: Phase = {
    ...chapter,
    parentId: targetParentId,
    customNumber: undefined,
  };

  // Coleta irmãos do nível destino (excluindo o próprio)
  const siblings = project.phases
    .filter(p => (p.parentId ?? null) === (targetParentId ?? null) && p.id !== chapterId)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

  const insertAt = Math.min(desiredIndex, siblings.length);
  siblings.splice(insertAt, 0, movedChapter);

  // Reatribui order sequencial e limpa customNumber dos irmãos para evitar conflito
  const orderMap = new Map<string, number>();
  siblings.forEach((s, i) => orderMap.set(s.id, i));

  return {
    ...project,
    phases: project.phases.map(p => {
      if (p.id === chapterId) {
        return { ...movedChapter, order: orderMap.get(chapterId) ?? 0 };
      }
      if ((p.parentId ?? null) === (targetParentId ?? null) && orderMap.has(p.id)) {
        return { ...p, order: orderMap.get(p.id)!, customNumber: undefined };
      }
      return p;
    }),
  };
}

/** Verifica se `candidateId` é descendente de `ancestorId` na árvore atual. */
function isDescendant(project: Project, candidateId: string, ancestorId: string): boolean {
  const map = new Map(project.phases.map(p => [p.id, p] as const));
  let current = map.get(candidateId);
  const visited = new Set<string>();
  while (current?.parentId) {
    if (visited.has(current.id)) return false; // proteção
    visited.add(current.id);
    if (current.parentId === ancestorId) return true;
    current = map.get(current.parentId);
  }
  return false;
}

/** Coleta todas as tarefas de um capítulo (incluindo seus subcapítulos). */
export function getChapterTasks(project: Project, chapterId: string): Task[] {
  const phaseById = new Map(project.phases.map(phase => [phase.id, phase]));
  const descendants = new Set<string>([chapterId]);
  const queue = [chapterId];
  while (queue.length) {
    const current = queue.shift()!;
    project.phases.filter(phase => phase.parentId === current).forEach(phase => {
      if (descendants.has(phase.id)) return;
      descendants.add(phase.id);
      queue.push(phase.id);
    });
  }
  return Array.from(descendants).flatMap(id => flattenTaskTree(phaseById.get(id)?.tasks ?? []));
}

/** Numeração hierárquica recursiva: "1", "1.1", "1.1.1", "2", ... */
export function getChapterNumbering(project: Project): Map<string, string> {
  const tree = getChapterTree(project);
  const map = new Map<string, string>();
  const walk = (nodes: ChapterNode[], prefix: string) => {
    nodes.forEach((node, idx) => {
      const auto = prefix ? `${prefix}.${idx + 1}` : String(idx + 1);
      const num = node.phase.customNumber?.trim() || auto;
      map.set(node.phase.id, num);
      if (node.children.length) walk(node.children, num);
    });
  };
  walk(tree, '');
  // Phases legadas / órfãs não enumeradas: numera na sequência
  let next = tree.length + 1;
  project.phases.forEach(p => {
    if (!map.has(p.id)) {
      map.set(p.id, p.customNumber?.trim() || String(next++));
    }
  });
  return map;
}

// ─── Validação de movimentação de capítulo ────────────────────────────

export interface ChapterMoveValidation {
  blocked: boolean;
  warnings: string[];
  violations: Array<{ taskId: string; taskName: string; predId: string; predName: string; type: DependencyType }>;
}

/** Coleta todas as tarefas do projeto. */
function getAllProjectTasks(project: Project): Task[] {
  return project.phases.flatMap(p => p.tasks);
}

/**
 * Valida se mover um capítulo causaria violações de dependência.
 * Como mover um capítulo não altera datas de tarefas (apenas seu agrupamento
 * visual via parentId), violações "duras" só ocorrem se já houver dependências
 * inconsistentes ou se a movimentação criar ciclo. Geramos avisos quando
 * existem dependências cruzadas com o pai antigo / dentro do novo destino.
 */
export function validateChapterMove(
  project: Project,
  chapterId: string,
  newParentId: string | null,
): ChapterMoveValidation {
  const result: ChapterMoveValidation = { blocked: false, warnings: [], violations: [] };

  // Ciclo
  if (newParentId && (chapterId === newParentId || isDescendant(project, newParentId, chapterId))) {
    result.blocked = true;
    result.warnings.push('Movimentação criaria um ciclo na hierarquia.');
    return result;
  }

  const allTasks = getAllProjectTasks(project);
  const movedTasks = getChapterTasks(project, chapterId);
  const movedIds = new Set(movedTasks.map(t => t.id));

  // Verifica violações duras: se alguma tarefa do capítulo já tem violação
  // ativa com suas dependências (pré-existente, mas exposta ao reorganizar).
  for (const task of movedTasks) {
    const v = checkDependencyViolation(task, task.startDate, allTasks);
    if (v) {
      result.violations.push({
        taskId: task.id,
        taskName: task.name,
        predId: v.predId,
        predName: v.predName,
        type: v.type,
      });
    }
  }

  // Avisos: dependências cruzadas com o pai antigo
  const oldParent = project.phases.find(p => p.id === chapterId)?.parentId;
  if (oldParent && oldParent !== newParentId) {
    const oldParentTasks = getChapterTasks(project, oldParent);
    const oldParentIds = new Set(oldParentTasks.map(t => t.id));
    for (const task of movedTasks) {
      const crosses = (task.dependencyDetails || []).some(d => oldParentIds.has(d.taskId) && !movedIds.has(d.taskId));
      if (crosses) {
        result.warnings.push(`Tarefa "${task.name}" mantém dependência com o capítulo de origem.`);
        break;
      }
    }
  }

  if (result.violations.length > 0) result.blocked = true;
  return result;
}

/**
 * Aplica a movimentação. Se houver violações e `force` for true, remove
 * as dependências conflitantes antes de mover.
 */
export function safeMoveChapter(
  project: Project,
  chapterId: string,
  newParentId: string | null,
  options: { force?: boolean } = {},
): { project: Project; validation: ChapterMoveValidation; applied: boolean } {
  const validation = validateChapterMove(project, chapterId, newParentId);

  if (validation.blocked && !options.force) {
    return { project, validation, applied: false };
  }

  let next = project;
  if (validation.violations.length > 0 && options.force) {
    // Remove dependências conflitantes
    const conflictPairs = new Set(validation.violations.map(v => `${v.taskId}::${v.predId}`));
    next = {
      ...next,
      phases: next.phases.map(p => ({
        ...p,
        tasks: p.tasks.map(t => {
          const hasConflict = (t.dependencies || []).some(d => conflictPairs.has(`${t.id}::${d}`));
          if (!hasConflict) return t;
          return {
            ...t,
            dependencies: (t.dependencies || []).filter(d => !conflictPairs.has(`${t.id}::${d}`)),
            dependencyDetails: (t.dependencyDetails || []).filter(d => !conflictPairs.has(`${t.id}::${d.taskId}`)),
          };
        }),
      })),
    };
  }

  next = moveChapter(next, chapterId, newParentId);
  return { project: next, validation, applied: true };
}
