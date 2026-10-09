import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DailyReport } from '@/types/project';
import type { DailyReportDraft } from '@/lib/dailyReportDrafts';

const labels: Array<[keyof DailyReport, string]> = [['responsible', 'Responsável'], ['weather', 'Clima'], ['workCondition', 'Condição de trabalho'], ['occurrences', 'Ocorrências'], ['impediments', 'Impedimentos'], ['observations', 'Observações'], ['teamsPresent', 'Equipes'], ['equipment', 'Equipamentos'], ['attachments', 'Anexos'], ['noProductionDeclared', 'Sem produção']];
function display(value: unknown) { return typeof value === 'string' ? value : value == null ? '—' : JSON.stringify(value, null, 2); }
export default function DailyReportDraftRecovery({ draft, confirmed, message, busy, onRetry, onDiscard }: {
  draft: DailyReportDraft; confirmed?: DailyReport | null; message?: string; busy: boolean; onRetry: () => void; onDiscard: () => void;
}) {
  const [compare, setCompare] = useState(false);
  const date = draft.local.date.split('-').reverse().join('/');
  return <section role="alert" className="mx-4 mt-4 space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
    <p><strong>Diário de {date}: edição pendente.</strong> {message}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>{busy ? 'Aguardando confirmação…' : 'Reenviar'}</Button>
      <Button size="sm" variant="outline" onClick={() => setCompare(value => !value)}>{compare ? 'Fechar comparação' : 'Comparar'}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>Descartar rascunho</Button>
    </div>
    {compare && <div className="overflow-x-auto"><table className="w-full table-fixed border-collapse text-left">
      <thead><tr><th className="w-1/5 p-2">Campo</th><th className="p-2">Confirmado</th><th className="p-2">Rascunho</th></tr></thead>
      <tbody>{labels.filter(([key]) => JSON.stringify(confirmed?.[key]) !== JSON.stringify(draft.local[key])).map(([key, label]) => <tr key={key} className="border-t border-border"><th className="p-2 align-top">{label}</th><td className="whitespace-pre-wrap break-words p-2 align-top">{display(confirmed?.[key])}</td><td className="whitespace-pre-wrap break-words p-2 align-top">{display(draft.local[key])}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}