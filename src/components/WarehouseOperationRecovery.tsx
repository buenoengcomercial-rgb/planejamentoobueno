import { useEffect, useState } from 'react';
import { retryWarehouseOutbox, warehousePendingOperations, type WarehousePendingOperation } from '@/lib/warehouseOperationOutbox';
export default function WarehouseOperationRecovery({ actorId, projectId, onConfirmed }: {
  actorId: string; projectId: string; onConfirmed: () => Promise<void>;
}) {
  const [rows, setRows] = useState<WarehousePendingOperation[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => { try { setRows(warehousePendingOperations(actorId, projectId)); }
      catch { setError('Não foi possível ler as tentativas preservadas. Mantenha este navegador aberto.'); } };
    refresh(); window.addEventListener('storage', refresh); window.addEventListener('obraplanner:warehouse-operations', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('obraplanner:warehouse-operations', refresh); };
  }, [actorId, projectId]);
  if (!rows.length && !error) return null;
  const retry = async (row: WarehousePendingOperation) => {
    setBusy(true); setError('');
    try { await retryWarehouseOutbox(actorId, projectId, row, onConfirmed); }
    catch (error) { setError((error as { message?: string }).message ?? 'Não foi possível conferir a operação.'); }
    finally { setBusy(false); }
  };
  const download = (row: WarehousePendingOperation) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(row, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `almoxarifado-tentativa-${row.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <aside aria-label="Tentativas do Almoxarifado" className="m-3 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
    <details><summary className="cursor-pointer font-medium">Tentativas preservadas do Almoxarifado ({rows.length})</summary>
      <p className="my-2">Confira a operação antes de criar outra. A conferência reutiliza a tentativa original e não duplica os registros.</p>
      {rows.map(row => <div key={row.id} className="my-2 border-t pt-2">
        <p>{row.conflict || 'A resposta do salvamento ainda precisa ser conferida.'}</p>
        {!row.conflict && <button className="mr-3 underline" disabled={busy} onClick={() => void retry(row)}>Conferir operação pendente</button>}
        <button className="underline" onClick={() => download(row)}>Baixar tentativa</button>
      </div>)}
      {error && <p role="alert">{error}</p>}
    </details>
  </aside>;
}
