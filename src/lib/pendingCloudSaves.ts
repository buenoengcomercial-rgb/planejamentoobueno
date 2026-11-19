type CloudSave = () => Promise<boolean>;
const saves = new Map<string, CloudSave>();

export function registerPendingCloudSave(id: string, save: CloudSave): () => void {
  saves.set(id, save);
  return () => { if (saves.get(id) === save) saves.delete(id); };
}

export async function flushPendingCloudSaves(): Promise<boolean> {
  for (const save of saves.values()) if (!await save()) return false;
  return true;
}
