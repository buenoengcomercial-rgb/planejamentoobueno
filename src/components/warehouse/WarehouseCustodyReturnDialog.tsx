import { useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { useWarehouseEditBase } from '@/hooks/useWarehouseEditBase';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { makeAttachments, returnCustodyEquipment, warehouseOperationalDate, type ActiveCustodyItem } from '@/lib/warehouse';
import type { CustodyEquipmentStatus, Project, WarehouseAuditActor } from '@/types/project';
import { WarehouseField } from './WarehouseVisual';

type ReturnStatus = Exclude<CustodyEquipmentStatus, 'em_uso'>;

interface Props {
  project: Project;
  target: ActiveCustodyItem;
  onProjectChange: (next: Project) => void;
  onCommitWarehouseScoped?: (next: Project, domain: 'custody', expectedBase?: Project) => Promise<Project>;
  auditActor?: WarehouseAuditActor;
  onClose: () => void;
}

export default function WarehouseCustodyReturnDialog({ project, target: { term, item }, onProjectChange, onCommitWarehouseScoped, auditActor, onClose }: Props) {
  const editBase = useWarehouseEditBase(project, term.id);
  const [returnData, setReturnData] = useState({
    returnedAt: warehouseOperationalDate(),
    stateOnReturn: '',
    divergenceNotes: '',
    status: 'devolvido' as ReturnStatus,
  });
  const [returnPhotos, setReturnPhotos] = useState<File[]>([]);
  const [returning, setReturning] = useState(false);
  const submitting = useRef(false);

  const submitReturn = async () => {
    if (submitting.current) return;
    const exception = returnData.status !== 'devolvido';
    if (exception && !returnData.divergenceNotes.trim()) return toast.error('Descreva a ocorrência da devolução.');
    if (exception && !returnPhotos.length) return toast.error('Adicione ao menos uma foto da ocorrência.');
    submitting.current = true;
    setReturning(true);
    try {
      if (!onCommitWarehouseScoped && import.meta.env.MODE !== 'test') {
        throw new Error('A transação segura de cautela ainda não está disponível. Nada foi gravado.');
      }
      const returnAttachments = await makeAttachments(returnPhotos, project.id, 'foto', 'equipment-returns');
      const next = returnCustodyEquipment(project, term.id, item.equipmentId, { ...returnData, returnAttachments }, auditActor);
      if (onCommitWarehouseScoped) {
        const accepted = await onCommitWarehouseScoped(next, 'custody', editBase.project);
        editBase.confirmed(accepted);
      } else {
        onProjectChange(next);
      }
      onClose();
      toast.success('Devolução do equipamento registrada.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      submitting.current = false;
      setReturning(false);
    }
  };

  return (
    <Dialog open onOpenChange={value => { if (!value && !returning) onClose(); }}>
      <DialogContent className="warehouse-ui max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Devolver equipamento</DialogTitle><DialogDescription>{term.number} · {item.equipmentInternalCode || ''} {item.equipmentName} · {term.workerName}</DialogDescription></DialogHeader>
        <fieldset disabled={returning} className="grid min-w-0 gap-3 sm:grid-cols-2">
          <WarehouseField label="Data da devolução"><Input className="min-h-11 text-base" type="date" value={returnData.returnedAt} onChange={event => setReturnData({ ...returnData, returnedAt: event.target.value })} /></WarehouseField>
          <WarehouseField label="Resultado"><select className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={returnData.status} onChange={event => setReturnData({ ...returnData, status: event.target.value as ReturnStatus })}><option value="devolvido">Devolvido OK</option><option value="divergencia">Com divergência</option><option value="danificado">Danificado</option><option value="perdido">Perdido</option></select></WarehouseField>
          <div className="sm:col-span-2"><WarehouseField label="Estado na devolução"><Input className="min-h-11 text-base" value={returnData.stateOnReturn} onChange={event => setReturnData({ ...returnData, stateOnReturn: event.target.value })} placeholder="Condição observada" /></WarehouseField></div>
          {returnData.status !== 'devolvido' && <div className="sm:col-span-2"><WarehouseField label="Descrição da ocorrência (obrigatória)"><Input className="min-h-11 text-base" value={returnData.divergenceNotes} onChange={event => setReturnData({ ...returnData, divergenceNotes: event.target.value })} /></WarehouseField></div>}
          <div className="sm:col-span-2"><label htmlFor="custody-return-photos" className="mb-1 block text-xs font-semibold">Fotos {returnData.status === 'devolvido' ? '(opcionais)' : '(ao menos uma obrigatória)'}</label><Input id="custody-return-photos" className="min-h-11 text-base" type="file" accept="image/*" capture="environment" multiple onChange={event => setReturnPhotos(Array.from(event.target.files ?? []).filter(file => file.type.startsWith('image/')).slice(0, 3))} /><div className="mt-1 text-xs text-muted-foreground">{returnPhotos.length} foto(s) selecionada(s)</div></div>
        </fieldset>
        <DialogFooter><Button variant="outline" className="min-h-11" disabled={returning} onClick={onClose}>Cancelar</Button><Button className="min-h-11" disabled={returning} onClick={() => void submitReturn()}><Undo2 className="mr-2 h-4 w-4" />{returning ? 'Registrando...' : 'Confirmar devolução'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
