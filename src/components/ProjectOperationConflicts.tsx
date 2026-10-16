import { useEffect, useState } from 'react';
import { commitProjectFields, pendingProjectFieldOperations, preserveProjectFieldConflict, ProjectFieldConflictError,
  type PendingProjectFieldOperation, type ProjectFieldReceipt } from '@/lib/projectFieldCommit';

export default function ProjectOperationConflicts({ actorId, projectId, organizationId, onRecovered }: {
  actorId: string; projectId: string; organizationId: string;
  onRecovered: (receipt: ProjectFieldReceipt, operation: PendingProjectFieldOperation) => Promise<void>;
}) {
  const [operations, setOperations] = useState<PendingProjectFieldOperation[]>([]);
  const [storageError, setStorageError] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    const refresh = () => {
      try { setOperations(pendingProjectFieldOperations(actorId, projectId)); setStorageError(false); }
      catch { setStorageError(true); }
    };
    refresh();
    window.addEventListener('storage', refresh);
    window.addEventListener('obraplanner:operation-conflicts', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('obraplanner:operation-conflicts', refresh); };
  }, [actorId, projectId]);
  if (!operations.length && !storageError) return null;
  const download = (operation: PendingProjectFieldOperation) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(operation, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `tentativa-${operation.operationId}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const retry = async (operation: PendingProjectFieldOperation) => {
    setBusy(true); setMessage('');
    try {
      await commitProjectFields(projectId, organizationId, actorId, operation.request, receipt => onRecovered(receipt, operation));
      setOperations(pendingProjectFieldOperations(actorId, projectId));
    } catch (error) {
      if (error instanceof ProjectFieldConflictError) preserveProjectFieldConflict(error, undefined);
      setMessage((error as { message?: string }).message ?? 'Não foi possível conferir a operação.');
    } finally { setBusy(false); }
  };
  return <aside className="m-3 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950" aria-label="Operações em conflito">
    <details>
      <summary className="cursor-pointer font-medium">Operações pendentes ou em conflito ({operations.length}) — tentativas preservadas neste navegador</summary>
      <p className="my-2">O primeiro valor confirmado foi mantido. As outras áreas continuam disponíveis. Confira a tentativa antes de fazer uma nova edição.</p>
      {storageError && <p role="alert">Não foi possível ler as tentativas locais. Mantenha este navegador aberto.</p>}
      {message && <p role="alert">{message}</p>}
      {operations.map(operation => <div key={operation.operationId} className="my-2 border-t pt-2">
        <p>{operation.conflict?.message || 'A resposta desta gravação ainda precisa ser conferida.'}</p>
        {!operation.conflict && <button disabled={busy} className="mr-3 underline" onClick={() => void retry(operation)}>Conferir salvamento pendente</button>}
        <button className="my-1 underline" onClick={() => download(operation)}>Baixar tentativa preservada</button>
      </div>)}
    </details>
  </aside>;
}
