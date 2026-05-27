type PendingEditCommit = () => void;

const pendingCommits = new Map<string, PendingEditCommit>();

export function registerPendingEditCommit(id: string, commit: PendingEditCommit): () => void {
  pendingCommits.set(id, commit);
  return () => {
    if (pendingCommits.get(id) === commit) pendingCommits.delete(id);
  };
}

function blurActiveEditableElement(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return false;

  const tag = active.tagName.toLowerCase();
  const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable;
  if (!editable || typeof active.blur !== 'function') return false;

  active.blur();
  return true;
}

export function flushPendingEditCommits(): number {
  let committed = 0;

  if (blurActiveEditableElement()) committed += 1;

  for (const [id, commit] of Array.from(pendingCommits.entries())) {
    try {
      commit();
      committed += 1;
    } catch (err) {
      console.warn(`Nao foi possivel confirmar a edicao pendente ${id}.`, err);
    }
  }

  return committed;
}
