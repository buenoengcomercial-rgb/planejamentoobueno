import { useState } from 'react';
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

export default function AdditiveHeaderInfo({
  project, active, bdi, globalDiscount, isLocked,
  onProjectChange, onChangeBdi, onChangeGlobalDiscount, onUpdateAdditive,
}: Props) {
  const [open, setOpen] = useState(false);
  const ci: ContractInfo = project.contractInfo || {};

  const patchContract = (patch: Partial<ContractInfo>) => {
    onProjectChange(prev => ({ ...prev, contractInfo: { ...(prev.contractInfo || {}), ...patch } }));
  };

  const issueDateValue = (active.headerIssueDate || '').slice(0, 10);

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
            </div>
            <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="p-4 pt-2 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label="Obra">
              <Input
                value={project.name || ''}
                onChange={e => onProjectChange(prev => ({ ...prev, name: e.target.value }))}
              />
            </Field>
            <Field label="Contratante">
              <Input
                value={ci.contractor || ''}
                onChange={e => patchContract({ contractor: e.target.value })}
              />
            </Field>
            <Field label="Contratada">
              <Input
                value={ci.contracted || ''}
                onChange={e => patchContract({ contracted: e.target.value })}
              />
            </Field>
            <Field label="Local / Município">
              <Input
                value={ci.location || ''}
                onChange={e => patchContract({ location: e.target.value })}
              />
            </Field>
            <Field label="Objeto" className="md:col-span-2">
              <Input
                value={ci.contractObject || ''}
                onChange={e => patchContract({ contractObject: e.target.value })}
              />
            </Field>
            <Field label="Nº do Contrato">
              <Input
                value={ci.contractNumber || ''}
                onChange={e => patchContract({ contractNumber: e.target.value })}
              />
            </Field>
            <Field label="Nº ART">
              <Input
                value={ci.artNumber || ''}
                onChange={e => patchContract({ artNumber: e.target.value })}
              />
            </Field>
            <Field label="Fonte de Orçamento">
              <Input
                value={ci.budgetSource || ''}
                onChange={e => patchContract({ budgetSource: e.target.value })}
              />
            </Field>
            <Field label="BDI (%)">
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                value={Number.isFinite(bdi) ? bdi : 0}
                disabled={isLocked}
                onChange={e => onChangeBdi(e.target.value)}
              />
            </Field>
            <Field label="Desconto Licit. (%)">
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                value={Number.isFinite(globalDiscount) ? globalDiscount : 0}
                disabled={isLocked}
                onChange={e => onChangeGlobalDiscount(e.target.value)}
              />
            </Field>
            <Field label="Data de Emissão">
              <Input
                type="date"
                value={issueDateValue}
                onChange={e => {
                  const v = e.target.value;
                  onUpdateAdditive(a => ({ ...a, headerIssueDate: v ? new Date(v).toISOString() : undefined }));
                }}
              />
            </Field>
            <Field label="Responsável">
              <Input
                value={active.headerResponsible ?? active.approvedBy ?? ''}
                onChange={e => onUpdateAdditive(a => ({ ...a, headerResponsible: e.target.value }))}
              />
            </Field>
          </div>
          <div className="px-4 pb-4 flex justify-end">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>Fechar</Button>
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
