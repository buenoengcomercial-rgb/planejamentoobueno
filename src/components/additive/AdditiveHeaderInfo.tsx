import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, FileText } from 'lucide-react';
import type { Project, ContractInfo, Additive } from '@/types/project';

interface Props {
  project: Project;
  active: Additive;
  bdi: number;
  globalDiscount: number;
  isLocked: boolean;
  onProjectChange: (next: Project | ((prev: Project) => Project)) => void;
  onChangeBdi: (v: string) => void;
  onChangeGlobalDiscount: (v: string) => void;
  onUpdateAdditive: (mutator: (a: Additive) => Additive) => void;
}

interface Draft {
  name: string;
  contractor: string;
  contracted: string;
  location: string;
  contractObject: string;
  contractNumber: string;
  artNumber: string;
  budgetSource: string;
  bdi: string;
  globalDiscount: string;
  issueDate: string;
  responsible: string;
}

function buildDraft(project: Project, active: Additive, bdi: number, globalDiscount: number): Draft {
  const ci: ContractInfo = project.contractInfo || {};
  return {
    name: project.name || '',
    contractor: ci.contractor || '',
    contracted: ci.contracted || '',
    location: ci.location || '',
    contractObject: ci.contractObject || '',
    contractNumber: ci.contractNumber || '',
    artNumber: ci.artNumber || '',
    budgetSource: ci.budgetSource || '',
    bdi: String(Number.isFinite(bdi) ? bdi : 0),
    globalDiscount: String(Number.isFinite(globalDiscount) ? globalDiscount : 0),
    issueDate: (active.headerIssueDate || '').slice(0, 10),
    responsible: active.headerResponsible ?? active.approvedBy ?? '',
  };
}

export default function AdditiveHeaderInfo({
  project, active, bdi, globalDiscount, isLocked,
  onProjectChange, onChangeBdi, onChangeGlobalDiscount, onUpdateAdditive,
}: Props) {
  const [open, setOpen] = useState(false);
  const saved = useMemo(
    () => buildDraft(project, active, bdi, globalDiscount),
    [project, active, bdi, globalDiscount],
  );
  const [draft, setDraft] = useState<Draft>(saved);

  // Reset draft when the underlying additive changes (switch tabs).
  useEffect(() => {
    setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id]);

  const dirty = useMemo(() => {
    return (Object.keys(saved) as (keyof Draft)[]).some(k => saved[k] !== draft[k]);
  }, [saved, draft]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft(d => ({ ...d, [k]: v }));

  const save = () => {
    // Project + contractInfo (single batched update)
    onProjectChange(prev => ({
      ...prev,
      name: draft.name,
      contractInfo: {
        ...(prev.contractInfo || {}),
        contractor: draft.contractor,
        contracted: draft.contracted,
        location: draft.location,
        contractObject: draft.contractObject,
        contractNumber: draft.contractNumber,
        artNumber: draft.artNumber,
        budgetSource: draft.budgetSource,
      },
    }));
    if (!isLocked) {
      if (String(bdi) !== draft.bdi) onChangeBdi(draft.bdi);
      if (String(globalDiscount) !== draft.globalDiscount) onChangeGlobalDiscount(draft.globalDiscount);
    }
    onUpdateAdditive(a => ({
      ...a,
      headerIssueDate: draft.issueDate ? new Date(draft.issueDate).toISOString() : undefined,
      headerResponsible: draft.responsible || undefined,
    }));
  };

  const reset = () => setDraft(saved);

  return (
    <Card className="border-dashed">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left hover:bg-muted/40 rounded-t-lg"
          >
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium text-sm">Dados do Cabeçalho (relatórios)</span>
              <span className="text-xs text-muted-foreground hidden md:inline">
                — usado em todas as exportações Excel/PDF
              </span>
              {dirty && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                  Alterações pendentes
                </span>
              )}
            </div>
            <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="p-4 pt-2 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label="Obra">
              <Input value={draft.name} onChange={e => set('name', e.target.value)} />
            </Field>
            <Field label="Contratante">
              <Input value={draft.contractor} onChange={e => set('contractor', e.target.value)} />
            </Field>
            <Field label="Contratada">
              <Input value={draft.contracted} onChange={e => set('contracted', e.target.value)} />
            </Field>
            <Field label="Local / Município">
              <Input value={draft.location} onChange={e => set('location', e.target.value)} />
            </Field>
            <Field label="Objeto" className="md:col-span-2">
              <Input value={draft.contractObject} onChange={e => set('contractObject', e.target.value)} />
            </Field>
            <Field label="Nº do Contrato">
              <Input value={draft.contractNumber} onChange={e => set('contractNumber', e.target.value)} />
            </Field>
            <Field label="Nº ART">
              <Input value={draft.artNumber} onChange={e => set('artNumber', e.target.value)} />
            </Field>
            <Field label="Fonte de Orçamento">
              <Input value={draft.budgetSource} onChange={e => set('budgetSource', e.target.value)} />
            </Field>
            <Field label="BDI (%)">
              <Input
                type="number" inputMode="decimal" step="0.01"
                value={draft.bdi} disabled={isLocked}
                onChange={e => set('bdi', e.target.value)}
              />
            </Field>
            <Field label="Desconto Licit. (%)">
              <Input
                type="number" inputMode="decimal" step="0.01"
                value={draft.globalDiscount} disabled={isLocked}
                onChange={e => set('globalDiscount', e.target.value)}
              />
            </Field>
            <Field label="Data de Emissão">
              <Input
                type="date" value={draft.issueDate}
                onChange={e => set('issueDate', e.target.value)}
              />
            </Field>
            <Field label="Responsável">
              <Input value={draft.responsible} onChange={e => set('responsible', e.target.value)} />
            </Field>
          </div>
          <div className="px-4 pb-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={reset} disabled={!dirty}>Descartar</Button>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>Fechar</Button>
            <Button size="sm" onClick={save} disabled={!dirty}>Salvar cabeçalho</Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1 ${className || ''}`}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
