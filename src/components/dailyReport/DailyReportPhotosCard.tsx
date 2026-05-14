import { Camera, Plus, Trash2, Image as ImageIcon, Loader2, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { DailyReportAttachment } from '@/types/project';
import { GENERAL_TASK_VALUE } from '@/components/dailyReport/dailyReportFormat';
import { usePhotoSrc } from '@/lib/photoUrl';

function PhotoThumb({ att }: { att: DailyReportAttachment }) {
  const src = usePhotoSrc(att);
  if (!src) {
    return (
      <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">Sem preview</div>
    );
  }
  return (
    <img src={src} alt={att.caption || att.fileName || 'foto'} className="w-full h-full object-cover" loading="lazy" />
  );
}

export interface PhotoTaskOption {
  value: string;
  label: string;
  phaseChain: string;
  quantity: number;
  unit: string;
  taskName: string;
}

interface DailyReportPhotosCardProps {
  photos: DailyReportAttachment[];
  visiblePhotos: DailyReportAttachment[];
  photosByTask: Map<string, number>;
  photoTaskOptions: PhotoTaskOption[];
  pendingTaskId: string;
  setPendingTaskId: (v: string) => void;
  photoFilter: string;
  setPhotoFilter: (v: string) => void;
  uploadingCount: number;
  fileInputRef: React.RefObject<HTMLInputElement>;
  handleFiles: (files: FileList) => void;
  updatePhoto: (id: string, patch: Partial<DailyReportAttachment>) => void;
  setLightbox: (p: DailyReportAttachment | null) => void;
  setConfirmDelete: (p: DailyReportAttachment | null) => void;
}

export function DailyReportPhotosCard({
  photos,
  visiblePhotos,
  photosByTask,
  photoTaskOptions,
  pendingTaskId,
  setPendingTaskId,
  photoFilter,
  setPhotoFilter,
  uploadingCount,
  fileInputRef,
  handleFiles,
  updatePhoto,
  setLightbox,
  setConfirmDelete,
}: DailyReportPhotosCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="text-sm flex items-center gap-2">
          <Camera className="w-4 h-4 text-primary" /> Fotos da Obra ({photos.length})
        </CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <Label className="text-[11px] text-muted-foreground">Vincular à atividade:</Label>
            <Select value={pendingTaskId} onValueChange={setPendingTaskId}>
              <SelectTrigger className="h-8 text-xs w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GENERAL_TASK_VALUE}>Foto geral do dia / Sem atividade específica</SelectItem>
                {photoTaskOptions.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            capture="environment"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />
          <Button size="sm" variant="default" onClick={() => fileInputRef.current?.click()} disabled={uploadingCount > 0}>
            {uploadingCount > 0 ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
            Anexar fotos
          </Button>
        </div>
      </CardHeader>
      <CardContent
        className="space-y-3"
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFiles(e.dataTransfer.files);
          }
        }}
      >
        {/* Filtro por atividade */}
        {photos.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="w-3.5 h-3.5 text-muted-foreground" />
            <Button size="sm" variant={photoFilter === 'all' ? 'default' : 'outline'} className="h-7 text-[11px]" onClick={() => setPhotoFilter('all')}>
              Todas ({photos.length})
            </Button>
            {photosByTask.has(GENERAL_TASK_VALUE) && (
              <Button size="sm" variant={photoFilter === GENERAL_TASK_VALUE ? 'default' : 'outline'} className="h-7 text-[11px]" onClick={() => setPhotoFilter(GENERAL_TASK_VALUE)}>
                Geral ({photosByTask.get(GENERAL_TASK_VALUE)})
              </Button>
            )}
            {photoTaskOptions.filter(o => photosByTask.has(o.value)).map(o => (
              <Button key={o.value} size="sm" variant={photoFilter === o.value ? 'default' : 'outline'} className="h-7 text-[11px]" onClick={() => setPhotoFilter(o.value)}>
                {o.taskName} ({photosByTask.get(o.value)})
              </Button>
            ))}
          </div>
        )}

        {visiblePhotos.length === 0 ? (
          <div className="border border-dashed border-border rounded-md py-8 text-center text-xs text-muted-foreground">
            <ImageIcon className="w-6 h-6 mx-auto mb-1 opacity-50" />
            {photos.length === 0
              ? 'Nenhuma foto anexada. Arraste imagens aqui ou clique em "Anexar fotos".'
              : 'Nenhuma foto neste filtro.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {visiblePhotos.map(p => {
              return (
                <div key={p.id} className="border border-border rounded-md overflow-hidden bg-card group">
                  <div className="relative aspect-[4/3] bg-muted cursor-pointer" onClick={() => setLightbox(p)}>
                    <PhotoThumb att={p} />

                    <button
                      type="button"
                      className="absolute top-1 right-1 w-6 h-6 rounded-full bg-destructive/90 text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(p); }}
                      title="Remover foto"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="p-2 space-y-1.5">
                    <Input
                      className="h-7 text-[11px]"
                      placeholder="Legenda"
                      value={p.caption || ''}
                      onChange={(e) => updatePhoto(p.id, { caption: e.target.value })}
                    />
                    <Select
                      value={p.taskId || GENERAL_TASK_VALUE}
                      onValueChange={(v) => {
                        if (v === GENERAL_TASK_VALUE) {
                          updatePhoto(p.id, { taskId: undefined, taskName: undefined, phaseChain: undefined, quantity: undefined, unit: undefined });
                        } else {
                          const meta = photoTaskOptions.find(o => o.value === v);
                          updatePhoto(p.id, { taskId: v, taskName: meta?.taskName, phaseChain: meta?.phaseChain, quantity: meta?.quantity, unit: meta?.unit });
                        }
                      }}
                    >
                      <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={GENERAL_TASK_VALUE}>Geral / Sem atividade</SelectItem>
                        {photoTaskOptions.map(o => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {p.uploadedAt && (
                      <div className="text-[10px] text-muted-foreground truncate">
                        {new Date(p.uploadedAt).toLocaleString('pt-BR')}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
