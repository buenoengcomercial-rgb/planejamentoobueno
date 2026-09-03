import { Fragment, useMemo, useRef, useState } from 'react';
import type {
  CustodyEquipmentStatus,
  CustodyTerm,
  CustodyTermEquipmentItem,
  Project,
  WarehouseAuditActor,
} from '@/types/project';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Camera,
  Check,
  ChevronDown,
  FileDown,
  History,
  ImagePlus,
  Plus,
  Search,
  Trash2,
  Undo2,
  Wrench,
  X,
} from 'lucide-react';
import {
  custodyTermAggregateStatus,
  custodyTermEquipmentItems,
  ensureWarehouse,
  hardDeleteCustodyTerm,
  issueCustodyTerm,
  makeAttachment,
  returnCustodyEquipment,
  warehouseActorName,
} from '@/lib/warehouse';
import { deleteWarehouseAttachments } from '@/lib/warehouseAttachments';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { getChapterNumbering } from '@/lib/chapters';
import SignaturePad from './SignaturePad';
import WarehouseAuditIdentity from './WarehouseAuditIdentity';
import { generateCustodyTermPdf } from './pdf';
import { toast } from 'sonner';
import {
  WarehouseActionBar,
  WarehouseEmptyState,
  WarehouseEquipmentThumbnail,
  WarehouseField,
  WarehouseSectionHeader,
  WarehouseStatusBadge,
  type WarehouseTone,
} from './WarehouseVisual';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
  auditActor?: WarehouseAuditActor;
  canDelete?: boolean;
}

interface CustodyFormItem {
  equipmentId: string;
  stateOnDelivery: string;
  accessories: string;
}

interface CustodyForm {
  issuedAt: string;
  chapterId: string;
  workerName: string;
  dueDate: string;
  signatureReceiver?: string;
  equipments: CustodyFormItem[];
}

type CustodyErrors = Partial<Record<'chapterId' | 'workerName' | 'equipments' | 'signatureReceiver', string>>;

interface ReturnTarget {
  term: CustodyTerm;
  item: CustodyTermEquipmentItem;
}

type ReturnStatus = Exclude<CustodyEquipmentStatus, 'em_uso'>;

const initialForm = (): CustodyForm => ({
  issuedAt: new Date().toISOString().slice(0, 10),
  chapterId: '',
  workerName: '',
  dueDate: '',
  equipments: [],
});

const normalizeSearch = (value?: string) => (value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('pt-BR')
  .trim();

const statusLabel: Record<string, string> = {
  em_uso: 'Em uso',
  parcial: 'Devolução parcial',
  devolvido: 'Devolvido',
  divergencia: 'Com divergência',
  danificado: 'Danificado',
  perdido: 'Perdido',
  encerrado_com_ocorrencia: 'Encerrado com ocorrência',
};

const statusTone = (status: string): WarehouseTone => {
  if (status === 'devolvido') return 'success';
  if (status === 'em_uso') return 'info';
  if (status === 'parcial') return 'warning';
  if (['divergencia', 'danificado', 'perdido', 'encerrado_com_ocorrencia'].includes(status)) return 'danger';
  return 'neutral';
};

type CustodyBuildingGroup = {
  key: string;
  label: string;
  terms: CustodyTerm[];
  equipmentCount: number;
  isMissingBuilding: boolean;
};

function custodyBuildingLabel(project: Project, chapterId?: string) {
  if (!chapterId) return { key: 'missing-building', label: 'Prédio não informado', isMissingBuilding: true };
  const phaseById = new Map(project.phases.map(phase => [phase.id, phase]));
  const visited = new Set<string>();
  let building = phaseById.get(chapterId);
  while (building?.parentId && !visited.has(building.id)) {
    visited.add(building.id);
    building = phaseById.get(building.parentId);
  }
  if (!building) return { key: 'missing-building', label: 'Prédio não informado', isMissingBuilding: true };
  const number = getChapterNumbering(project).get(building.id);
  return { key: building.id, label: `${number ? `${number} · ` : ''}${building.name}`, isMissingBuilding: false };
}

function groupCustodyTermsByBuilding(project: Project, terms: CustodyTerm[]): CustodyBuildingGroup[] {
  const byBuilding = new Map<string, CustodyTerm[]>();
  for (const term of terms) {
    const building = custodyBuildingLabel(project, term.chapterId);
    byBuilding.set(building.key, [...(byBuilding.get(building.key) ?? []), term]);
  }
  return Array.from(byBuilding.entries()).map(([key, buildingTerms]) => {
    const building = custodyBuildingLabel(project, buildingTerms[0].chapterId);
    return {
      key,
      label: building.label,
      isMissingBuilding: building.isMissingBuilding,
      terms: buildingTerms,
      equipmentCount: buildingTerms.reduce((total, term) => total + custodyTermEquipmentItems(term).length, 0),
    };
  }).sort((left, right) => Number(left.isMissingBuilding) - Number(right.isMissingBuilding) || left.label.localeCompare(right.label, 'pt-BR', { numeric: true }));
}

export default function WarehouseCustodyTab({ project, onProjectChange, auditActor, canDelete = false }: Props) {
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const wh = ensureWarehouse(project).warehouse!;
  const numbering = useMemo(() => getChapterNumbering(project), [project]);
  const chapters = useMemo(
    () => (project.phases ?? []).filter(phase => !phase.parentId).map(phase => ({
      id: phase.id,
      name: `${numbering.get(phase.id) ?? phase.customNumber ?? ''} ${phase.name}`.trim(),
    })),
    [numbering, project.phases],
  );
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [form, setForm] = useState<CustodyForm>(initialForm);
  const [equipmentSearch, setEquipmentSearch] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<CustodyErrors>({});
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [returnTarget, setReturnTarget] = useState<ReturnTarget | null>(null);
  const [returnData, setReturnData] = useState({
    returnedAt: new Date().toISOString().slice(0, 10),
    stateOnReturn: '',
    divergenceNotes: '',
    status: 'devolvido' as ReturnStatus,
  });
  const [returnPhotos, setReturnPhotos] = useState<File[]>([]);
  const [returning, setReturning] = useState(false);

  const availableEquipments = useMemo(() => {
    const tokens = normalizeSearch(equipmentSearch).split(/\s+/).filter(Boolean);
    return wh.equipments
      .filter(equipment => !equipment.archivedAt && (equipment.status ?? 'disponivel') === 'disponivel')
      .filter(equipment => !form.equipments.some(item => item.equipmentId === equipment.id))
      .filter(equipment => {
        const haystack = normalizeSearch([
          equipment.internalCode,
          equipment.patrimony,
          equipment.serial,
          equipment.description,
          equipment.name,
          equipment.brand,
          equipment.model,
        ].filter(Boolean).join(' '));
        return tokens.every(token => haystack.includes(token));
      });
  }, [equipmentSearch, form.equipments, wh.equipments]);

  const reset = () => {
    setForm(initialForm());
    setEquipmentSearch('');
    setPhotos([]);
    setErrors({});
    setOpen(false);
  };

  const addPhotos = (files: FileList | null, current: File[], setter: (files: File[]) => void) => {
    if (!files) return;
    const incoming = Array.from(files).filter(file => file.type.startsWith('image/'));
    setter([...current, ...incoming].slice(0, 3));
    if (current.length + incoming.length > 3) toast.warning('Use no máximo três fotos.');
  };

  const addEquipment = (equipmentId: string) => {
    if (form.equipments.some(item => item.equipmentId === equipmentId)) return;
    setForm(current => ({
      ...current,
      equipments: [...current.equipments, { equipmentId, stateOnDelivery: '', accessories: '' }],
    }));
    setEquipmentSearch('');
    setErrors(current => ({ ...current, equipments: undefined }));
  };

  const updateEquipment = (equipmentId: string, patch: Partial<CustodyFormItem>) => {
    setForm(current => ({
      ...current,
      equipments: current.equipments.map(item => item.equipmentId === equipmentId ? { ...item, ...patch } : item),
    }));
  };

  const submit = async () => {
    const chapter = chapters.find(candidate => candidate.id === form.chapterId);
    const nextErrors: CustodyErrors = {};
    if (!chapter) nextErrors.chapterId = 'Selecione o destino.';
    if (!form.workerName.trim()) nextErrors.workerName = 'Informe quem recebeu.';
    if (!form.equipments.length) nextErrors.equipments = 'Adicione ao menos um equipamento.';
    if (!form.signatureReceiver) nextErrors.signatureReceiver = 'Colete a assinatura.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      const first = ['chapterId', 'workerName', 'equipments', 'signatureReceiver'].find(key => nextErrors[key as keyof CustodyErrors]);
      const targets: Record<string, string> = { chapterId: 'custody-chapter', workerName: 'custody-worker', equipments: 'custody-equipment-search' };
      const target = first === 'signatureReceiver'
        ? document.querySelector<HTMLElement>('[aria-label="Assinatura de quem recebeu"]')
        : document.getElementById(targets[first ?? ''] ?? '');
      target?.focus();
      toast.error(nextErrors[first as keyof CustodyErrors] ?? 'Revise os campos destacados.');
      return;
    }
    setErrors({});
    try {
      setSaving(true);
      const attachments = await Promise.all(photos.map(file => makeAttachment(file, project.id, 'foto', 'equipment-custody')));
      const next = issueCustodyTerm(project, {
        issuedAt: form.issuedAt,
        dueDate: form.dueDate || undefined,
        chapterId: chapter.id,
        chapterName: chapter.name,
        workerName: form.workerName.trim(),
        signatureReceiver: form.signatureReceiver,
        attachments,
        equipments: form.equipments,
      }, auditActor);
      const createdId = next.warehouse!.custodyTerms.at(-1)?.id ?? null;
      onProjectChange(next);
      setExpandedId(createdId);
      reset();
      toast.success('Cautela emitida e equipamentos marcados como Em uso.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const startReturn = (term: CustodyTerm, item: CustodyTermEquipmentItem) => {
    setReturnTarget({ term, item });
    setReturnData({ returnedAt: new Date().toISOString().slice(0, 10), stateOnReturn: '', divergenceNotes: '', status: 'devolvido' });
    setReturnPhotos([]);
  };

  const submitReturn = async () => {
    if (!returnTarget) return;
    const exception = returnData.status !== 'devolvido';
    if (exception && !returnData.divergenceNotes.trim()) return toast.error('Descreva a ocorrência da devolução.');
    if (exception && !returnPhotos.length) return toast.error('Adicione ao menos uma foto da ocorrência.');
    try {
      setReturning(true);
      const returnAttachments = await Promise.all(returnPhotos.map(file => makeAttachment(file, project.id, 'foto', 'equipment-returns')));
      onProjectChange(returnCustodyEquipment(project, returnTarget.term.id, returnTarget.item.equipmentId, {
        ...returnData,
        returnAttachments,
      }, auditActor));
      setReturnTarget(null);
      setReturnPhotos([]);
      toast.success('Devolução do equipamento registrada.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setReturning(false);
    }
  };

  const sortedTerms = wh.custodyTerms.slice().sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || b.createdAt.localeCompare(a.createdAt));
  const custodyBuildingGroups = useMemo(() => groupCustodyTermsByBuilding(project, sortedTerms), [project, sortedTerms]);
  const deleteTerm = (term: CustodyTerm) => confirm(
    { title: 'Excluir cautela definitivamente?', description: 'O termo, suas fotos e devoluções vinculadas serão removidos; equipamentos ainda em uso voltarão para disponível.', confirmLabel: 'Excluir definitivamente' },
    async () => {
      onProjectChange(hardDeleteCustodyTerm(project, term.id));
      const attachments = [
        ...(term.attachments ?? []), ...(term.returnAttachments ?? []),
        ...custodyTermEquipmentItems(term).flatMap(item => item.returnAttachments ?? []),
      ];
      try { await deleteWarehouseAttachments(attachments); } catch { toast.warning('A cautela foi excluída, mas houve falha ao remover um anexo do Storage.'); }
      setExpandedId(null);
      toast.success('Cautela excluída e equipamentos restaurados.');
    },
  );

  return (
    <div className="space-y-3">
      <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={event => { addPhotos(event.target.files, photos, setPhotos); event.target.value = ''; }} />
      <input ref={galleryRef} className="hidden" type="file" accept="image/*" multiple onChange={event => { addPhotos(event.target.files, photos, setPhotos); event.target.value = ''; }} />

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3 shadow-sm">
        <Button className="min-h-11" onClick={() => setOpen(value => !value)}>
          {open ? <X className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
          {open ? 'Fechar cautela' : 'Nova cautela'}
        </Button>
        <span className="text-sm font-medium text-muted-foreground">Preencha os dados e escolha os equipamentos.</span>
        <span className="ml-auto text-xs text-muted-foreground">{wh.custodyTerms.length} registro(s)</span>
      </div>

      {open && (
        <section className="space-y-4 rounded-xl border bg-card p-3 shadow-sm">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <WarehouseField label="Data"><Input className="min-h-11 text-base" type="date" value={form.issuedAt} onChange={event => setForm({ ...form, issuedAt: event.target.value })} /></WarehouseField>
            <WarehouseField label="Prédio / capítulo" error={errors.chapterId}><select id="custody-chapter" className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={form.chapterId} onChange={event => { setForm({ ...form, chapterId: event.target.value }); setErrors(current => ({ ...current, chapterId: undefined })); }}><option value="">Selecione</option>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}</select></WarehouseField>
            <WarehouseField label="Quem recebeu" error={errors.workerName}><Input id="custody-worker" className="min-h-11 text-base" value={form.workerName} onChange={event => { setForm({ ...form, workerName: event.target.value }); setErrors(current => ({ ...current, workerName: undefined })); }} placeholder="Nome do responsável" /></WarehouseField>
            <WarehouseField label="Devolução prevista" optional><Input className="min-h-11 text-base" type="date" value={form.dueDate} onChange={event => setForm({ ...form, dueDate: event.target.value })} /></WarehouseField>
          </div>
          <div className="text-xs text-muted-foreground">Almoxarife identificado pelo login: <strong className="text-foreground">{warehouseActorName(auditActor)}</strong></div>

          <div className="overflow-hidden rounded-xl border">
            <WarehouseSectionHeader icon={Wrench} title="Escolha os equipamentos" description="Toque em + para adicionar." help="A busca encontra código interno, patrimônio, série, descrição, marca e modelo. Somente equipamentos disponíveis aparecem." />
            <div className="p-3">
              <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input id="custody-equipment-search" className="min-h-11 pl-9 text-base" value={equipmentSearch} onChange={event => setEquipmentSearch(event.target.value)} placeholder="Nome, código, patrimônio ou série" aria-label="Buscar equipamento" /></div>
              <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border bg-background" aria-label="Equipamentos disponíveis">
                {availableEquipments.map((equipment, index) => <button key={equipment.id} type="button" className={`flex min-h-[72px] w-full items-center gap-3 border-b px-3 py-2 text-left last:border-0 hover:bg-primary/10 ${index % 2 ? 'bg-muted/25' : ''}`} onClick={() => addEquipment(equipment.id)}><WarehouseEquipmentThumbnail equipment={equipment} /><span className="min-w-0 flex-1"><span className="block text-sm font-bold leading-snug">{equipment.description || equipment.name}</span><span className="mt-1 block text-xs font-medium text-muted-foreground">{equipment.internalCode || 'Código legado'} · Patrimônio {equipment.patrimony || '—'} · Série {equipment.serial || '—'}</span></span><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true"><Plus className="h-5 w-5" /></span></button>)}
                {!availableEquipments.length && <WarehouseEmptyState message="Nenhum equipamento disponível" hint="Tente outra palavra na busca." className="m-2" icon={Wrench} />}
              </div>
              {errors.equipments && <div role="alert" className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm font-semibold text-destructive">{errors.equipments}</div>}
              <div className="mt-3 space-y-2">
                {form.equipments.map(item => {
                  const equipment = wh.equipments.find(candidate => candidate.id === item.equipmentId);
                  if (!equipment) return null;
                  return <div key={item.equipmentId} className="grid gap-2 rounded-md border p-2 md:grid-cols-[minmax(180px,1fr)_minmax(160px,1fr)_minmax(160px,1fr)_44px] md:items-end"><div className="min-w-0 self-center"><div className="truncate text-sm font-medium">{equipment.internalCode || 'Código legado'} · {equipment.description || equipment.name}</div><div className="text-xs text-muted-foreground">Patrimônio {equipment.patrimony || '—'} · Série {equipment.serial || '—'}</div></div><Field label="Estado na entrega"><Input className="min-h-11 text-base" value={item.stateOnDelivery} onChange={event => updateEquipment(item.equipmentId, { stateOnDelivery: event.target.value })} placeholder="Ex.: bom estado" /></Field><Field label="Acessórios"><Input className="min-h-11 text-base" value={item.accessories} onChange={event => updateEquipment(item.equipmentId, { accessories: event.target.value })} placeholder="Opcional" /></Field><Button size="icon" variant="ghost" className="min-h-11 min-w-11 text-destructive" onClick={() => setForm(current => ({ ...current, equipments: current.equipments.filter(candidate => candidate.equipmentId !== item.equipmentId) }))} aria-label={`Remover ${equipment.description || equipment.name}`}><Trash2 className="h-4 w-4" /></Button></div>;
                })}
                {!form.equipments.length && <WarehouseEmptyState message="Nenhum equipamento escolhido" hint="Toque em + para adicionar." icon={Wrench} />}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={`rounded-lg border bg-muted/30 p-3 ${errors.signatureReceiver ? 'border-destructive bg-destructive/5' : ''}`}><SignaturePad label="Assinatura de quem recebeu" value={form.signatureReceiver} onChange={signatureReceiver => { setForm(current => ({ ...current, signatureReceiver })); setErrors(current => ({ ...current, signatureReceiver: undefined })); }} />{errors.signatureReceiver && <div role="alert" className="mt-2 text-sm font-semibold text-destructive">{errors.signatureReceiver}</div>}</div>
            <div className="rounded-lg border bg-muted/30 p-3"><OptionalPhotos photos={photos} onCamera={() => cameraRef.current?.click()} onGallery={() => galleryRef.current?.click()} onRemove={index => setPhotos(current => current.filter((_, photoIndex) => photoIndex !== index))} /></div>
          </div>
          <WarehouseActionBar><Button variant="outline" className="min-h-11 bg-background" disabled={saving} onClick={reset}>Cancelar</Button><Button className="min-h-11 font-bold" disabled={saving} onClick={() => void submit()}><Check className="mr-2 h-4 w-4" />{saving ? 'Emitindo...' : 'Emitir cautela'}</Button></WarehouseActionBar>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border bg-card">
        <WarehouseSectionHeader icon={History} title="Histórico de cautelas" description={`${sortedTerms.length} registro(s)`} tone="neutral" />
        <div className="space-y-4 p-2 md:hidden">
          {custodyBuildingGroups.map(building => <section key={building.key} data-testid="custody-building-group" className="space-y-2"><CustodyBuildingHeader label={building.label} termCount={building.terms.length} equipmentCount={building.equipmentCount} />{building.terms.map(term => <CustodyMobileCard key={term.id} term={term} expanded={expandedId === term.id} onToggle={() => setExpandedId(current => current === term.id ? null : term.id)} onReturn={startReturn} project={project} canDelete={canDelete} onDelete={() => deleteTerm(term)} />)}</section>)}
          {!sortedTerms.length && <WarehouseEmptyState message="Nenhuma cautela emitida" hint="Use Nova cautela para começar." icon={Wrench} />}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[840px] text-xs">
            <thead className="bg-muted"><tr><th className="w-10 p-2"><span className="sr-only">Detalhes</span></th><th className="p-2 text-left">Nº</th><th className="p-2 text-left">Data</th><th className="p-2 text-left">Recebedor</th><th className="p-2 text-left">Prédio / capítulo</th><th className="p-2 text-center">Equipamentos</th><th className="p-2 text-left">Prazo</th><th className="p-2 text-left">Status</th></tr></thead>
            <tbody>{custodyBuildingGroups.map(building => <Fragment key={building.key}><tr data-testid="custody-building-group"><td colSpan={8} className="border-t bg-primary/10 px-3 py-2"><CustodyBuildingHeader label={building.label} termCount={building.terms.length} equipmentCount={building.equipmentCount} /></td></tr>{building.terms.map(term => {
              const items = custodyTermEquipmentItems(term);
              const expanded = expandedId === term.id;
              const aggregate = custodyTermAggregateStatus(items);
              return <Fragment key={term.id}><tr className={`cursor-pointer border-t whitespace-nowrap hover:bg-muted/30 ${expanded ? 'bg-primary/10' : ''}`} onClick={() => setExpandedId(current => current === term.id ? null : term.id)}><td className="p-2"><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></td><td className="p-2 font-mono">{term.number}</td><td className="p-2">{term.issuedAt}</td><td className="p-2">{term.workerName}</td><td className="max-w-64 truncate p-2" title={term.chapterName}>{term.chapterName || 'Registro legado'}</td><td className="p-2 text-center">{items.length}</td><td className="p-2">{term.dueDate || 'Sem prazo'}</td><td className="p-2"><WarehouseStatusBadge label={statusLabel[aggregate] || aggregate} tone={statusTone(aggregate)} /></td></tr>{expanded && <tr className="border-t bg-muted/10"><td colSpan={8} className="p-3"><CustodyDetails term={term} project={project} onReturn={startReturn} canDelete={canDelete} onDelete={() => deleteTerm(term)} /></td></tr>}</Fragment>;
            })}</Fragment>)}{!sortedTerms.length && <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">Nenhuma cautela emitida.</td></tr>}</tbody>
          </table>
        </div>
      </section>

      <Dialog open={!!returnTarget} onOpenChange={value => { if (!value && !returning) setReturnTarget(null); }}>
        <DialogContent className="warehouse-ui max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader><DialogTitle>Devolver equipamento</DialogTitle><DialogDescription>{returnTarget?.term.number} · {returnTarget?.item.equipmentInternalCode || ''} {returnTarget?.item.equipmentName}</DialogDescription></DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Data da devolução"><Input className="min-h-11 text-base" type="date" value={returnData.returnedAt} onChange={event => setReturnData({ ...returnData, returnedAt: event.target.value })} /></Field>
            <Field label="Resultado"><select className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={returnData.status} onChange={event => setReturnData({ ...returnData, status: event.target.value as ReturnStatus })}><option value="devolvido">Devolvido OK</option><option value="divergencia">Com divergência</option><option value="danificado">Danificado</option><option value="perdido">Perdido</option></select></Field>
            <div className="sm:col-span-2"><Field label="Estado na devolução"><Input className="min-h-11 text-base" value={returnData.stateOnReturn} onChange={event => setReturnData({ ...returnData, stateOnReturn: event.target.value })} placeholder="Condição observada" /></Field></div>
            {returnData.status !== 'devolvido' && <div className="sm:col-span-2"><Field label="Descrição da ocorrência (obrigatória)"><Input className="min-h-11 text-base" value={returnData.divergenceNotes} onChange={event => setReturnData({ ...returnData, divergenceNotes: event.target.value })} /></Field></div>}
            <div className="sm:col-span-2"><label className="mb-1 block text-xs font-semibold">Fotos {returnData.status === 'devolvido' ? '(opcionais)' : '(ao menos uma obrigatória)'}</label><Input className="min-h-11 text-base" type="file" accept="image/*" capture="environment" multiple onChange={event => setReturnPhotos(Array.from(event.target.files ?? []).filter(file => file.type.startsWith('image/')).slice(0, 3))} /><div className="mt-1 text-xs text-muted-foreground">{returnPhotos.length} foto(s) selecionada(s)</div></div>
          </div>
          <DialogFooter><Button variant="outline" className="min-h-11" disabled={returning} onClick={() => setReturnTarget(null)}>Cancelar</Button><Button className="min-h-11" disabled={returning} onClick={() => void submitReturn()}><Undo2 className="mr-2 h-4 w-4" />{returning ? 'Registrando...' : 'Confirmar devolução'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <WarehouseField label={label}>{children}</WarehouseField>;
}

function CustodyBuildingHeader({ label, termCount, equipmentCount }: { label: string; termCount: number; equipmentCount: number }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><strong className="min-w-0 break-words">{label}</strong><span className="text-muted-foreground">{termCount} cautela(s) · {equipmentCount} equipamento(s)</span></div>;
}

function OptionalPhotos({ photos, onCamera, onGallery, onRemove }: { photos: File[]; onCamera: () => void; onGallery: () => void; onRemove: (index: number) => void }) {
  return <div className="space-y-3"><div className="flex items-center gap-2 text-sm font-bold">Fotos da entrega <span className="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">Opcional · até 3</span></div><div className="grid grid-cols-3 gap-2">{photos.map((photo, index) => <PhotoPreview key={`${photo.name}-${index}`} file={photo} onRemove={() => onRemove(index)} />)}</div><div className="grid grid-cols-2 gap-2"><Button type="button" variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3} onClick={onCamera}><Camera className="mr-2 h-4 w-4" />Tirar foto</Button><Button type="button" variant="outline" className="min-h-11 bg-background" disabled={photos.length >= 3} onClick={onGallery}><ImagePlus className="mr-2 h-4 w-4" />Galeria</Button></div></div>;
}

function PhotoPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  return <div className="relative aspect-square overflow-hidden rounded-md border"><img src={url} alt={file.name} className="h-full w-full object-cover" onLoad={() => URL.revokeObjectURL(url)} /><Button type="button" size="icon" variant="destructive" className="absolute right-1 top-1 h-8 w-8" onClick={onRemove} aria-label={`Remover ${file.name}`}><X className="h-4 w-4" /></Button></div>;
}

function CustodyDetails({ term, project, onReturn, canDelete, onDelete }: { term: CustodyTerm; project: Project; onReturn: (term: CustodyTerm, item: CustodyTermEquipmentItem) => void; canDelete: boolean; onDelete: () => void }) {
  const items = custodyTermEquipmentItems(term);
  return <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm"><strong>{term.number}</strong> · {term.workerName} · {term.attachments?.length || 0} foto(s) na entrega</div><div className="flex gap-2"><Button size="sm" variant="outline" className="min-h-11" onClick={() => generateCustodyTermPdf(project, term)}><FileDown className="mr-1 h-4 w-4" />PDF</Button>{canDelete && <Button size="sm" variant="destructive" className="min-h-11" onClick={onDelete}><Trash2 className="mr-1 h-4 w-4" />Excluir</Button>}</div></div><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-xs"><thead><tr><th className="p-2 text-left">Equipamento</th><th className="p-2 text-left">Estado / acessórios</th><th className="p-2 text-left">Situação</th><th className="p-2 text-left">Devolução</th><th className="p-2 text-right">Ação</th></tr></thead><tbody>{items.map(item => <tr key={item.equipmentId} className="border-t"><td className="p-2"><div className="font-medium">{item.equipmentInternalCode || 'Código legado'} · {item.equipmentName}</div><div className="text-muted-foreground">Patrimônio {item.equipmentPatrimony || '—'} · Série {item.equipmentSerial || '—'}</div></td><td className="p-2">{item.stateOnDelivery || '—'}<div className="text-muted-foreground">{item.accessories || 'Sem acessórios'}</div></td><td className="p-2"><WarehouseStatusBadge label={statusLabel[item.status] || item.status} tone={statusTone(item.status)} /></td><td className="p-2">{item.returnedAt || '—'}<div className="text-muted-foreground">{item.stateOnReturn || item.divergenceNotes || ''}</div></td><td className="p-2 text-right">{item.status === 'em_uso' && <Button size="sm" variant="outline" className="min-h-11" onClick={() => onReturn(term, item)}><Undo2 className="mr-1 h-4 w-4" />Devolver</Button>}</td></tr>)}</tbody></table></div><WarehouseAuditIdentity createdBy={term.createdBy} updatedBy={term.updatedBy} createdAt={term.createdAt} updatedAt={term.updatedAt} className="rounded-md bg-muted/40 p-2 text-xs" /></div>;
}

function CustodyMobileCard({ term, expanded, onToggle, onReturn, project, canDelete, onDelete }: { term: CustodyTerm; expanded: boolean; onToggle: () => void; onReturn: (term: CustodyTerm, item: CustodyTermEquipmentItem) => void; project: Project; canDelete: boolean; onDelete: () => void }) {
  const items = custodyTermEquipmentItems(term);
  const aggregate = custodyTermAggregateStatus(items);
  return <article className={`rounded-lg border ${expanded ? 'border-primary bg-primary/5' : ''}`}><button type="button" className="w-full p-3 text-left" onClick={onToggle} aria-expanded={expanded}><div className="flex justify-between gap-2"><strong>{term.number}</strong><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></div><div className="mt-1 text-sm font-semibold">{term.workerName}</div><div className="text-xs text-muted-foreground">{term.chapterName || 'Registro legado'} · {items.length} equipamento(s)</div><div className="mt-2 flex flex-wrap items-center gap-2"><WarehouseStatusBadge label={statusLabel[aggregate] || aggregate} tone={statusTone(aggregate)} /><span className="text-xs text-muted-foreground">{term.dueDate || 'Sem prazo'}</span></div></button>{expanded && <div className="border-t p-3"><CustodyDetails term={term} project={project} onReturn={onReturn} canDelete={canDelete} onDelete={onDelete} /></div>}</article>;
}
