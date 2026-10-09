import type { Project } from '@/types/project';

type Segment = string | { id: string };
interface Value { exists: boolean; value?: unknown }
export interface UndoChange { path: Segment[]; before: Value; after: Value }
export interface UndoOperation { projectId: string; changes: UndoChange[] }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keyed = (value: unknown[]): value is Array<Record<string, unknown> & { id: string }> =>
  value.every(item => record(item) && typeof item.id === 'string') && new Set(value.map(item => (item as { id: string }).id)).size === value.length;
const copy = <T,>(value: T): T => structuredClone(value);

/** Values are copied only for changed fields, never for the whole project. */
export function createUndoOperation(before: Project, after: Project): UndoOperation {
  const changes: UndoChange[] = [];
  const visit = (left: Value, right: Value, path: Segment[]) => {
    if (left.exists === right.exists && left.value === right.value) return;
    if (left.exists && right.exists && record(left.value) && record(right.value)) {
      const a = left.value, b = right.value;
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (path.length === 0 && (key === 'auditLogs' || key === 'id')) continue;
        visit({ exists: a[key] !== undefined, value: a[key] }, { exists: b[key] !== undefined, value: b[key] }, [...path, key]);
      }
      return;
    }
    if (Array.isArray(left.value) && Array.isArray(right.value) && keyed(left.value) && keyed(right.value)) {
      const a = new Map(left.value.map(item => [item.id, item]));
      const b = new Map(right.value.map(item => [item.id, item]));
      const commonA = left.value.filter(item => b.has(item.id)).map(item => item.id);
      const commonB = right.value.filter(item => a.has(item.id)).map(item => item.id);
      // Reordering is structural: require an exact match instead of guessing.
      if (!equal(commonA, commonB)) {
        changes.push({ path, before: copy(left), after: copy(right) });
        return;
      }
      for (const id of new Set([...a.keys(), ...b.keys()])) {
        visit({ exists: a.has(id), value: a.get(id) }, { exists: b.has(id), value: b.get(id) }, [...path, { id }]);
      }
      return;
    }
    if (!equal(left.value, right.value) || left.exists !== right.exists) changes.push({ path, before: copy(left), after: copy(right) });
  };
  visit({ exists: true, value: before }, { exists: true, value: after }, []);
  return { projectId: before.id, changes };
}

function read(root: unknown, path: Segment[]): Value {
  let value = root;
  for (const segment of path) {
    if (typeof segment === 'string') {
      if (!record(value) || value[segment] === undefined) return { exists: false };
      value = value[segment];
    } else {
      if (!Array.isArray(value)) return { exists: false };
      const item = value.find(entry => record(entry) && entry.id === segment.id);
      if (!item) return { exists: false };
      value = item;
    }
  }
  return { exists: true, value };
}

function replace(root: unknown, path: Segment[], restore: Value): unknown {
  const [segment, ...rest] = path;
  if (segment === undefined) return copy(restore.value);
  if (typeof segment === 'string') {
    if (!record(root)) throw new Error('Registro de origem indisponível.');
    const next = { ...root };
    if (rest.length === 0 && !restore.exists) delete next[segment];
    else next[segment] = replace(root[segment], rest, restore);
    return next;
  }
  if (!Array.isArray(root)) throw new Error('Coleção de origem indisponível.');
  const index = root.findIndex(item => record(item) && item.id === segment.id);
  if (rest.length === 0) {
    if (!restore.exists) return root.filter((_, i) => i !== index);
    if (index < 0) return [...root, copy(restore.value)];
  }
  if (index < 0) throw new Error('Registro de origem indisponível.');
  return root.map((item, i) => i === index ? replace(item, rest, restore) : item);
}

export function applyUndoOperation(current: Project, operation: UndoOperation): Project {
  if (current.id !== operation.projectId) throw new Error('Esta alteração pertence a outra obra.');
  for (const change of operation.changes) {
    const value = read(current, change.path);
    if (value.exists !== change.after.exists || !equal(value.value, change.after.value)) {
      throw new Error('Este registro mudou depois da operação. O Desfazer foi bloqueado para preservar a edição mais recente.');
    }
  }
  return operation.changes.reduce((project, change) => replace(project, change.path, change.before) as Project, current);
}