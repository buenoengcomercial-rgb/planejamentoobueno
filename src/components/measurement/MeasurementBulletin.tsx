import { useEffect, useRef, useState } from 'react';
import MeasurementContractInfo from './MeasurementContractInfo';
import { measurementBulletin, type MeasuredBulletin, type MeasurementWorkspace } from '@/lib/measurementWorkspace';
import type { WorkspaceDraft } from '@/lib/measurementWorkspaceStore';
import type { ContractInfo } from '@/types/project';

export const bulletinDraftKey = '__bulletin__';
export type BulletinPatch = Partial<Omit<MeasuredBulletin, 'contract'>> & { contract?: Partial<ContractInfo>; number?: number };
interface Props {
  workspace: MeasurementWorkspace; measurementId: string; readOnly: boolean; drafts: WorkspaceDraft[];
  onDraft: (field: string, value: string) => Promise<void>;
  onCommit: (fields: string[], patch: BulletinPatch, draftWritten: Promise<void>) => Promise<boolean>;
  registerFlush?: (flush: () => Promise<boolean>) => () => void;
}
const numeric = (value: string) => value.trim() ? Number(value.replace(',', '.')) : NaN;

/** Same contract form as the legacy screen; only the period-scoped save boundary differs. */
export default function MeasurementBulletin({ workspace, measurementId, readOnly, drafts, onDraft, onCommit, registerFlush }: Props) {
  const bulletin = measurementBulletin(workspace, measurementId);
  const period = workspace.periods.find(p => p.id === measurementId)!;
  const [edits, setEdits] = useState<Record<string, string>>(() => Object.fromEntries(drafts
    .filter(d => d.measurementId === measurementId && d.serviceId === bulletinDraftKey && d.rowId !== 'number')
    .map(d => [d.rowId, String(d.changes.value ?? '')])));
  const pendingDraft = useRef(Promise.resolve());
  const editsRef = useRef(edits);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const sending = useRef<Promise<boolean> | null>(null);
  const latest = useRef({ onCommit, readOnly }); latest.current = { onCommit, readOnly };
  const flushRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  const clearTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = undefined; };
  const flush = (): Promise<boolean> => {
    clearTimer();
    if (sending.current) return sending.current;
    const run = async () => {
      while (Object.keys(editsRef.current).length > 0) {
        if (latest.current.readOnly) return false;
        const submitted = { ...editsRef.current };
        const patch: BulletinPatch = {};
        for (const [field, text] of Object.entries(submitted)) {
          if (field === 'projectName') patch.projectName = text;
          else patch.contract = { ...patch.contract, [field]: field === 'bdiPercent' ? numeric(text) : text };
        }
        try {
          if (!await latest.current.onCommit(Object.keys(submitted), patch, pendingDraft.current)) return false;
        } catch { return false; }
        const remaining = { ...editsRef.current };
        for (const [field, text] of Object.entries(submitted)) if (remaining[field] === text) delete remaining[field];
        editsRef.current = remaining; setEdits(remaining);
      }
      return true;
    };
    const promise = run().finally(() => { sending.current = null; });
    sending.current = promise;
    return promise;
  };
  flushRef.current = flush;
  useEffect(() => registerFlush?.(() => flushRef.current()), [registerFlush]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const value = (field: string, saved: string | number | undefined) => edits[field] ?? String(saved ?? '');
  const change = (field: string, text: string) => {
    editsRef.current = { ...editsRef.current, [field]: text };
    setEdits(editsRef.current);
    // Finish queued keystroke drafts before clearing the confirmed field on blur.
    pendingDraft.current = pendingDraft.current.catch(() => undefined).then(() => onDraft(field, text));
    void pendingDraft.current.catch(() => undefined);
    clearTimer();
    timer.current = setTimeout(() => { void flushRef.current(); }, 1200);
  };
  const commit = () => { void flushRef.current(); };
  const textContract = (field: 'contractor' | 'contracted' | 'contractNumber' | 'contractObject' | 'location' | 'budgetSource' | 'artNumber') => value(field, bulletin.contract[field]);
  const bdi = value('bdiPercent', bulletin.contract.bdiPercent);
  const number = String(period.number);
  return <section aria-label="Boletim de medição para pagamento">
    <MeasurementContractInfo defaultOpen={false} project={{ name: value('projectName', bulletin.projectName) }}
      setProjectName={v => change('projectName', v)} onProjectNameChange={commit}
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
      measurementNumber={number} setMeasurementNumber={() => undefined} measurementNumberReadOnly
      persistContractInfo={commit}/>
    {Object.keys(edits).length > 0 && <p role="status" className="px-3 py-1 text-xs text-amber-800">Enviando alterações do boletim à nuvem…</p>}
  </section>;
}
