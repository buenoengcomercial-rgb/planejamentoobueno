type PendingForm = { label: string; isDirty: () => boolean };

const pendingForms = new Map<string, PendingForm>();

/** Formulários operacionais só entram no projeto após confirmação explícita. */
export function registerPendingForm(id: string, label: string, isDirty: () => boolean): () => void {
  const entry = { label, isDirty };
  pendingForms.set(id, entry);
  return () => {
    if (pendingForms.get(id) === entry) pendingForms.delete(id);
  };
}

export function getPendingFormNames(): string[] {
  return [...pendingForms.values()]
    .filter(form => form.isDirty())
    .map(form => form.label);
}
