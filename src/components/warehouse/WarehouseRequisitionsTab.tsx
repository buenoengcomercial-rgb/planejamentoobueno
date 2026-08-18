import { Fragment, useMemo, useRef, useState } from 'react';
import type { Project, WarehouseAuditActor, WarehouseRequisition, WarehouseRequisitionItem } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Camera, Check, ChevronDown, FileDown, HardHat, ImagePlus, PackageOpen, Plus, Search, Trash2, X } from 'lucide-react';
import {
  computeWarehouseRows,
  createAndDeliverRequisition,
  ensureWarehouse,
  makeAttachment,
  uidWarehouse,
  warehouseActorName,
} from '@/lib/warehouse';
import { getChapterNumbering } from '@/lib/chapters';
import { DEFAULT_TEAMS } from '@/lib/teams';
import SignaturePad from './SignaturePad';
import { generateRequisitionReceipt } from './pdf';
import WarehouseAuditIdentity from './WarehouseAuditIdentity';
import WarehouseCustodyTab from './WarehouseCustodyTab';
import { toast } from 'sonner';

interface Props { project: Project; onProjectChange: (next: Project) => void; auditActor?: WarehouseAuditActor; }

interface WithdrawalForm {
  date: string;
  chapterId: string;
  teamId: string;
  receiverName: string;
  notes: string;
  items: WarehouseRequisitionItem[];
  signatureReceiver?: string;
  deliveryIdempotencyKey: string;
}

const initialForm = (): WithdrawalForm => ({
  date: new Date().toISOString().slice(0, 10),
  chapterId: '',
  teamId: '',
  receiverName: '',
  notes: '',
  items: [],
  deliveryIdempotencyKey: uidWarehouse(),
});

const normalizeSearch = (value?: string) => (value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('pt-BR')
  .trim();

export default function WarehouseRequisitionsTab(props: Props) {
  return (
    <Tabs defaultValue="materiais" className="space-y-3">
      <TabsList className="grid h-auto min-h-11 w-full grid-cols-2 sm:w-fit sm:min-w-[360px]">
        <TabsTrigger value="materiais" className="min-h-11"><PackageOpen className="mr-2 h-4 w-4" />Materiais</TabsTrigger>
        <TabsTrigger value="equipamentos" className="min-h-11"><HardHat className="mr-2 h-4 w-4" />Equipamentos / Cautelas</TabsTrigger>
      </TabsList>
      <TabsContent value="materiais" className="mt-0"><WarehouseMaterialWithdrawalsTab {...props} /></TabsContent>
      <TabsContent value="equipamentos" className="mt-0"><WarehouseCustodyTab {...props} /></TabsContent>
    </Tabs>
  );
}

function WarehouseMaterialWithdrawalsTab({ project, onProjectChange, auditActor }: Props) {
  const wh = ensureWarehouse(project).warehouse!;
  const rows = useMemo(() => computeWarehouseRows(project, { includeManual: true }), [project]);
  const numbering = useMemo(() => getChapterNumbering(project), [project]);
  const chapters = useMemo(
    () => (project.phases ?? []).filter(phase => !phase.parentId).map(phase => ({
      id: phase.id,
      name: `${numbering.get(phase.id) ?? phase.customNumber ?? ''} ${phase.name}`.trim(),
    })),
    [numbering, project.phases],
  );
  const teams = useMemo(
    () => (project.teams?.length ? project.teams : DEFAULT_TEAMS).filter(team => team.active !== false),
    [project.teams],
  );
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState<WithdrawalForm>(initialForm);
  const [materialSearch, setMaterialSearch] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const availableMaterials = useMemo(() => {
    const tokens = normalizeSearch(materialSearch).split(/\s+/).filter(Boolean);
    return rows.filter(row => row.balance > 0 && !form.items.some(item => item.itemKey === row.key))
      .filter(row => {
        const haystack = normalizeSearch([row.code, row.description, row.unit].filter(Boolean).join(' '));
        return tokens.every(token => haystack.includes(token));
      });
  }, [form.items, materialSearch, rows]);

  const reset = () => {
    setForm(initialForm());
    setPhotos([]);
    setMaterialSearch('');
    setOpen(false);
  };

  const addMaterial = (key: string) => {
    const row = rows.find(candidate => candidate.key === key);
    if (!row || row.balance <= 0) return;
    setForm(current => ({
      ...current,
      items: [...current.items, {
        itemKey: row.key,
        code: row.code,
        description: row.description,
        unit: row.unit,
        quantity: 1,
      }],
    }));
    setMaterialSearch('');
  };

  const updateQuantity = (index: number, quantity: number) => {
    setForm(current => ({
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, quantity } : item),
    }));
  };

  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const incoming = Array.from(files).filter(file => file.type.startsWith('image/'));
    const next = [...photos, ...incoming].slice(0, 3);
    setPhotos(next);
    if (cameraRef.current) cameraRef.current.value = '';
    if (galleryRef.current) galleryRef.current.value = '';
    if (photos.length + incoming.length > 3) toast.warning('A retirada aceita no máximo três fotos.');
  };

  const submit = async () => {
    const chapter = chapters.find(candidate => candidate.id === form.chapterId);
    const team = teams.find(candidate => candidate.code === form.teamId);
    if (!chapter) return toast.error('Selecione o prédio/capítulo do orçamento.');
    if (!team) return toast.error('Selecione a equipe que recebeu os materiais.');
    if (!form.receiverName.trim()) return toast.error('Informe o nome de quem recebeu.');
    if (!form.items.length) return toast.error('Adicione ao menos um material.');
    const invalid = form.items.find(item => !(item.quantity > 0));
    if (invalid) return toast.error(`Informe uma quantidade válida para ${invalid.description}.`);
    const exceeds = form.items.find(item => item.quantity > (rows.find(row => row.key === item.itemKey)?.balance ?? 0));
    if (exceeds) return toast.error(`${exceeds.description}: a quantidade supera o saldo disponível.`);
    if (!form.signatureReceiver) return toast.error('Colete a assinatura de quem recebeu.');

    try {
      setSaving(true);
      const deliveryAttachments = await Promise.all(photos.map(file => makeAttachment(file, project.id, 'foto', 'withdrawals')));
      const result = createAndDeliverRequisition(project, {
        date: form.date,
        chapterId: chapter.id,
        chapterName: chapter.name,
        teamId: team.code,
        teamName: team.label,
        receiverName: form.receiverName.trim(),
        requesterName: form.receiverName.trim(),
        notes: form.notes.trim() || undefined,
        items: form.items,
        signatureReceiver: form.signatureReceiver,
        deliveryAttachments,
        deliveryIdempotencyKey: form.deliveryIdempotencyKey,
      }, { publishToDailyReport: true, actor: auditActor });
      onProjectChange(result.project);
      setActiveId(result.requisitionId);
      reset();
      toast.success('Retirada registrada e estoque baixado.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={event => addPhotos(event.target.files)} />
      <input ref={galleryRef} className="hidden" type="file" accept="image/*" multiple onChange={event => addPhotos(event.target.files)} />

      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2">
        <Button className="min-h-11" onClick={() => setOpen(value => !value)}>
          {open ? <X className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
          {open ? 'Fechar retirada' : 'Nova retirada'}
        </Button>
        <span className="text-sm text-muted-foreground">Entrega direta: equipe, prédio, recebedor, materiais e assinatura; foto opcional.</span>
        <span className="ml-auto text-xs text-muted-foreground">{wh.requisitions.length} registro(s)</span>
      </div>

      {open && (
        <section className="space-y-4 rounded-lg border bg-card p-3">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div><label htmlFor="withdrawal-date" className="mb-1 block text-xs font-semibold">Data</label><Input id="withdrawal-date" className="min-h-11 text-base" type="date" value={form.date} onChange={event => setForm({ ...form, date: event.target.value })} /></div>
            <div><label htmlFor="withdrawal-chapter" className="mb-1 block text-xs font-semibold">Prédio / capítulo</label><select id="withdrawal-chapter" className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={form.chapterId} onChange={event => setForm({ ...form, chapterId: event.target.value })}><option value="">Selecione</option>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}</select></div>
            <div><label htmlFor="withdrawal-team" className="mb-1 block text-xs font-semibold">Equipe</label><select id="withdrawal-team" className="min-h-11 w-full rounded-md border bg-background px-3 text-base" value={form.teamId} onChange={event => setForm({ ...form, teamId: event.target.value })}><option value="">Selecione</option>{teams.map(team => <option key={team.code} value={team.code}>{team.label}</option>)}</select></div>
            <div><label htmlFor="withdrawal-receiver" className="mb-1 block text-xs font-semibold">Quem recebeu</label><Input id="withdrawal-receiver" className="min-h-11 text-base" value={form.receiverName} onChange={event => setForm({ ...form, receiverName: event.target.value })} placeholder="Nome do recebedor" /></div>
          </div>
          <div className="text-xs text-muted-foreground">Almoxarife identificado pelo login: <strong className="text-foreground">{warehouseActorName(auditActor)}</strong></div>

          <div className="rounded-md border">
            <div className="border-b bg-muted/40 p-3"><div className="font-semibold">Materiais da retirada</div><div className="text-xs text-muted-foreground">Pesquise por código ou descrição. Somente materiais com saldo aparecem.</div></div>
            <div className="p-3">
              <label htmlFor="withdrawal-material-search" className="sr-only">Buscar material para adicionar</label><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input id="withdrawal-material-search" className="min-h-11 pl-9 text-base" value={materialSearch} onChange={event => setMaterialSearch(event.target.value)} placeholder="Buscar por código, descrição ou unidade" /></div>
              <div className="mt-2 max-h-64 overflow-y-auto rounded-md border" aria-label="Materiais disponíveis">{availableMaterials.map(row => <button key={row.key} type="button" className="flex min-h-11 w-full items-center gap-3 border-b px-3 text-left last:border-0 hover:bg-muted" onClick={() => addMaterial(row.key)}><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{row.description}</span><span className="text-xs text-muted-foreground">{row.code || 'Sem código'} · {row.unit}</span></span><span className="text-sm font-semibold text-primary">Saldo {row.balance.toLocaleString('pt-BR')}</span></button>)}{!availableMaterials.length && <div className="p-4 text-center text-sm text-muted-foreground">Nenhum material com saldo encontrado.</div>}</div>
              <div className="mt-3 grid gap-2">
                {form.items.map((item, index) => {
                  const row = rows.find(candidate => candidate.key === item.itemKey);
                  const balance = row?.balance ?? 0;
                  const after = balance - Number(item.quantity || 0);
                  return <div key={item.itemKey} className="grid min-h-16 items-center gap-2 rounded-md border p-2 sm:grid-cols-[1fr_120px_180px_44px]"><div className="min-w-0"><div className="truncate text-sm font-medium">{item.description}</div><div className="text-xs text-muted-foreground">{item.code || 'Sem código'} · {item.unit}</div></div><Input className="min-h-11 text-center" type="number" min="0" max={balance} step="any" value={item.quantity || ''} onChange={event => updateQuantity(index, Number(event.target.value))} aria-label={`Quantidade de ${item.description}`} /><div className="rounded-md bg-muted/50 p-2 text-center text-xs"><span>{balance.toLocaleString('pt-BR')}</span> − <strong>{Number(item.quantity || 0).toLocaleString('pt-BR')}</strong> = <span className={after < 0 ? 'text-destructive' : 'text-primary'}>{after.toLocaleString('pt-BR')} {item.unit}</span></div><Button size="icon" variant="ghost" className="min-h-11 min-w-11 text-destructive" onClick={() => setForm(current => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))} aria-label={`Remover ${item.description}`}><Trash2 className="h-4 w-4" /></Button></div>;
                })}
                {!form.items.length && <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">Nenhum material adicionado.</div>}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <SignaturePad label="Assinatura de quem recebeu" value={form.signatureReceiver} onChange={signatureReceiver => setForm(current => ({ ...current, signatureReceiver }))} />
            <div className="space-y-2"><div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fotos da entrega (opcionais, até 3)</div><div className="grid grid-cols-3 gap-2">{photos.map((photo, index) => <PhotoPreview key={`${photo.name}-${index}`} file={photo} onRemove={() => setPhotos(current => current.filter((_, photoIndex) => photoIndex !== index))} />)}</div><div className="grid grid-cols-2 gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={photos.length >= 3} onClick={() => cameraRef.current?.click()}><Camera className="mr-2 h-4 w-4" />Tirar foto</Button><Button type="button" variant="outline" className="min-h-11" disabled={photos.length >= 3} onClick={() => galleryRef.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />Galeria</Button></div></div>
          </div>
          <div><label htmlFor="withdrawal-notes" className="mb-1 block text-xs font-semibold">Observação</label><Input id="withdrawal-notes" className="min-h-11" value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} placeholder="Opcional" /></div>
          <div className="sticky bottom-0 -mx-3 -mb-3 flex justify-end gap-2 border-t bg-background p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] shadow-[0_-4px_12px_rgba(0,0,0,0.08)]"><Button variant="outline" className="min-h-11" disabled={saving} onClick={reset}>Cancelar</Button><Button className="min-h-11" disabled={saving} onClick={() => void submit()}><Check className="mr-2 h-4 w-4" />{saving ? 'Registrando...' : 'Entregar e baixar estoque'}</Button></div>
        </section>
      )}

      <section className="overflow-hidden rounded-md border bg-card">
          <div className="border-b bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Histórico de retiradas</div>
          <div className="space-y-2 p-2 md:hidden">{wh.requisitions.slice().sort((a, b) => b.date.localeCompare(a.date)).map(requisition => {
            const expanded = activeId === requisition.id;
            return <article key={requisition.id} className={`rounded-md border ${expanded ? 'border-primary bg-primary/5' : ''}`}><button type="button" className="w-full p-3 text-left" onClick={() => setActiveId(current => current === requisition.id ? null : requisition.id)} aria-expanded={expanded}><div className="flex justify-between gap-2"><strong>{requisition.number}</strong><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></div><div className="mt-1 text-sm">{requisition.receiverName || requisition.requesterName || '—'}</div><div className="text-xs text-muted-foreground">{requisition.chapterName || requisition.taskName || 'Registro legado'} · {requisition.items.length} item(ns) · {requisition.date}</div></button>{expanded && <div className="border-t p-3"><WithdrawalDetails project={project} requisition={requisition} /></div>}</article>;
          })}{!wh.requisitions.length && <div className="p-6 text-center text-sm text-muted-foreground">Nenhuma retirada registrada.</div>}</div>
          <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[980px] text-xs"><thead className="bg-muted"><tr><th className="w-10 p-2"><span className="sr-only">Detalhes</span></th><th className="p-2 text-left">Nº</th><th className="p-2 text-left">Data</th><th className="p-2 text-left">Recebedor</th><th className="p-2 text-left">Prédio / capítulo</th><th className="p-2 text-left">Equipe</th><th className="p-2 text-center">Itens</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Incluído / alterado por</th></tr></thead><tbody>{wh.requisitions.slice().sort((a, b) => b.date.localeCompare(a.date)).map(requisition => {
            const expanded = activeId === requisition.id;
            return <Fragment key={requisition.id}><tr className={`cursor-pointer border-t whitespace-nowrap hover:bg-muted/30 ${expanded ? 'bg-primary/10' : ''}`} onClick={() => setActiveId(current => current === requisition.id ? null : requisition.id)}><td className="p-2"><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></td><td className="p-2 font-mono">{requisition.number}</td><td className="p-2">{requisition.date}</td><td className="p-2">{requisition.receiverName || requisition.requesterName || '—'}</td><td className="max-w-72 truncate p-2" title={requisition.chapterName || requisition.taskName}>{requisition.chapterName || requisition.taskName || 'Registro legado'}</td><td className="p-2">{requisition.teamName || requisition.teamId || '—'}</td><td className="p-2 text-center">{requisition.items.length}</td><td className="p-2">{requisition.status === 'rascunho' ? 'Pendente legado' : requisition.status}</td><td className="p-2"><WarehouseAuditIdentity createdBy={requisition.createdBy} updatedBy={requisition.updatedBy} className="space-y-0.5" /></td></tr>{expanded && <tr className="border-t bg-muted/10"><td colSpan={9} className="p-3"><WithdrawalDetails project={project} requisition={requisition} /></td></tr>}</Fragment>;
          })}{!wh.requisitions.length && <tr><td colSpan={9} className="p-8 text-center text-muted-foreground">Nenhuma retirada registrada.</td></tr>}</tbody></table></div>
      </section>
    </div>
  );
}

function PhotoPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  return <div className="relative aspect-square overflow-hidden rounded-md border"><img src={url} alt={file.name} className="h-full w-full object-cover" onLoad={() => URL.revokeObjectURL(url)} /><Button type="button" size="icon" variant="destructive" className="absolute right-1 top-1 h-8 w-8" onClick={onRemove} aria-label={`Remover ${file.name}`}><X className="h-4 w-4" /></Button></div>;
}

function WithdrawalDetails({ project, requisition }: { project: Project; requisition: WarehouseRequisition }) {
  return <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm"><strong>{requisition.number}</strong> · {requisition.receiverName || requisition.requesterName || '—'} · {requisition.deliveryAttachments?.length || 0} foto(s)</div><Button size="sm" variant="outline" className="min-h-11" onClick={() => generateRequisitionReceipt(project, requisition)}><FileDown className="mr-1 h-4 w-4" />PDF</Button></div><dl className="grid gap-2 text-sm sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">Prédio / capítulo</dt><dd>{requisition.chapterName || requisition.taskName || 'Registro legado'}</dd></div><div><dt className="text-xs text-muted-foreground">Equipe</dt><dd>{requisition.teamName || requisition.teamId || '—'}</dd></div><div><dt className="text-xs text-muted-foreground">Observação</dt><dd>{requisition.notes || '—'}</dd></div></dl><div className="overflow-x-auto"><table className="w-full min-w-[520px] text-xs"><thead><tr><th className="p-2 text-left">Código</th><th className="p-2 text-left">Material</th><th className="p-2 text-left">Unidade</th><th className="p-2 text-right">Quantidade</th></tr></thead><tbody>{requisition.items.map(item => <tr key={item.itemKey} className="border-t"><td className="p-2">{item.code || '—'}</td><td className="p-2">{item.description}</td><td className="p-2">{item.unit}</td><td className="p-2 text-right">{item.quantity.toLocaleString('pt-BR')}</td></tr>)}</tbody></table></div><WarehouseAuditIdentity createdBy={requisition.createdBy} updatedBy={requisition.updatedBy} className="rounded-md bg-muted/40 p-2 text-xs" /></div>;
}
