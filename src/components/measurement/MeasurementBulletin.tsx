import { useRef, useState } from 'react';
import MeasurementContractInfo from './MeasurementContractInfo';
import { measurementBulletin, type MeasuredBulletin, type MeasurementWorkspace } from '@/lib/measurementWorkspace';
import type { WorkspaceDraft } from '@/lib/measurementWorkspaceStore';
import type { ContractInfo } from '@/types/project';

export const bulletinDraftKey = '__bulletin__';
export type BulletinPatch = Partial<Omit<MeasuredBulletin, 'contract'>> & { contract?: Partial<ContractInfo>; number?: number };
interface Props {
  workspace: MeasurementWorkspace; measurementId: string; readOnly: boolean; drafts: WorkspaceDraft[];
  onDraft: (field: string, value: string) => Promise<void>;
  onCommit: (field: string, patch: BulletinPatch, draftWritten: Promise<void>) => Promise<boolean>;
}
const numeric = (value: string) => value.trim() ? Number(value.replace(',', '.')) : NaN;

/** Same contract form as the legacy screen; only the period-scoped save boundary differs. */
export default function MeasurementBulletin({ workspace, measurementId, readOnly, drafts, onDraft, onCommit }: Props) {
  const bulletin = measurementBulletin(workspace, measurementId);
  const period = workspace.periods.find(p => p.id === measurementId)!;
  const [edits, setEdits] = useState<Record<string, string>>(() => Object.fromEntries(drafts
    .filter(d => d.measurementId === measurementId && d.serviceId === bulletinDraftKey)
    .map(d => [d.rowId, String(d.changes.value ?? '')])));
  const pendingDraft = useRef(Promise.resolve());
  const value = (field: string, saved: string | number | undefined) => edits[field] ?? String(saved ?? '');
  const change = (field: string, text: string) => {
    setEdits(previous => ({ ...previous, [field]: text }));
    // Finish queued keystroke drafts before clearing the confirmed field on blur.
    pendingDraft.current = pendingDraft.current.catch(() => undefined).then(() => onDraft(field, text));
    void pendingDraft.current.catch(() => undefined);
  };
  const commit = async (field: string, patch: BulletinPatch) => {
    if (readOnly || !(field in edits)) return;
    const submitted = edits[field];
    try {
      if (await onCommit(field, patch, pendingDraft.current)) setEdits(previous => {
        if (previous[field] !== submitted) return previous;
        const next = { ...previous }; delete next[field]; return next;
      });
    } catch { /* The parent surfaces persistence errors. Keep the editable draft. */ }
  };
  const textContract = (field: 'contractor' | 'contracted' | 'contractNumber' | 'contractObject' | 'location' | 'budgetSource' | 'artNumber') => value(field, bulletin.contract[field]);
  const bdi = value('bdiPercent', bulletin.contract.bdiPercent);
  const number = value('number', period.number);
  return <section aria-label="Boletim de medição para pagamento">
    <MeasurementContractInfo defaultOpen project={{ name: value('projectName', bulletin.projectName) }}
      setProjectName={v => change('projectName', v)} onProjectNameChange={name => void commit('projectName', { projectName: name })}
      isSnapshotMode={readOnly} effStart={period.startDate} effEnd={period.endDate} effIssue={bulletin.issueDate}
      effBdi={bulletin.contract.bdiPercent ?? 0} effNumber={readOnly ? String(period.number) : number}
      contractor={textContract('contractor')} setContractor={v => change('contractor', v)}
      contracted={textContract('contracted')} setContracted={v => change('contracted', v)}
      contractNumber={textContract('contractNumber')} setContractNumber={v => change('contractNumber', v)}
      contractObject={textContract('contractObject')} setContractObject={v => change('contractObject', v)}
      location={textContract('location')} setLocation={v => change('location', v)}
      budgetSource={textContract('budgetSource')} setBudgetSource={v => change('budgetSource', v)}
      artNumber={textContract('artNumber')} setArtNumber={v => change('artNumber', v)}
      bdiInput={bdi} setBdiInput={v => change('bdiPercent', v)} bdiPercent={numeric(bdi)}
      measurementNumber={number} setMeasurementNumber={v => change('number', v)}
      onMeasurementNumberCommit={() => void commit('number', { number: numeric(number) })}
      persistContractInfo={contract => void commit(Object.keys(contract)[0], { contract })}/>
    {Object.keys(edits).length > 0 && <p role="status" className="px-3 py-1 text-xs text-amber-800">Boletim com rascunho preservado. Finalize o campo para confirmar o salvamento.</p>}
  </section>;
}
