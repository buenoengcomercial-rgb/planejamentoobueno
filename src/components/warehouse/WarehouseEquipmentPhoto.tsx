import { useState } from 'react';
import type { Equipment } from '@/types/project';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WarehouseEquipmentThumbnail } from './WarehouseVisual';

/** A foto tem uma ação própria: ampliar nunca seleciona nem movimenta o equipamento. */
export default function WarehouseEquipmentPhoto({ equipment }: { equipment: Equipment }) {
  const [open, setOpen] = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);
  const title = equipment.description || equipment.name;
  const photos = equipment.photos ?? [];
  const selected = photos[photoIndex] ?? photos[0];
  return <>
    <button type="button" className="group relative block w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default" disabled={!photos.length} aria-label={`Ampliar foto de ${title}`} onClick={() => { setPhotoIndex(0); setOpen(true); }}>
      <WarehouseEquipmentThumbnail equipment={equipment} className="h-44 w-full bg-muted/30 [&_img]:object-contain [&_svg]:h-12 [&_svg]:w-12" />
      <span className="absolute inset-x-0 bottom-0 rounded-b-lg bg-background/90 px-2 py-1 text-xs font-semibold text-primary">{photos.length ? 'Toque para ampliar' : 'Sem foto cadastrada'}</span>
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="warehouse-ui w-[calc(100vw-1rem)] max-w-4xl overflow-y-auto max-h-[95dvh]">
        <DialogHeader className="pr-8">
          <DialogTitle>Foto do equipamento</DialogTitle>
          <DialogDescription className="break-words">{equipment.internalCode || 'Código legado'} · {title} · Patrimônio {equipment.patrimony || '—'}</DialogDescription>
        </DialogHeader>
        <WarehouseEquipmentThumbnail equipment={{ ...equipment, photos: selected ? [selected] : [] }} className="h-[60dvh] w-full [&_img]:object-contain [&_svg]:h-12 [&_svg]:w-12" />
        {photos.length > 1 && <div className="flex flex-wrap gap-2" aria-label="Fotos do equipamento">{photos.map((photo, index) => <button key={photo.id} type="button" aria-label={`Ver foto ${index + 1} de ${title}`} aria-pressed={index === photoIndex} onClick={() => setPhotoIndex(index)} className="rounded-lg p-1 aria-pressed:ring-2 aria-pressed:ring-primary"><WarehouseEquipmentThumbnail equipment={{ ...equipment, photos: [photo] }} className="h-16 w-20 [&_img]:object-contain" /></button>)}</div>}
      </DialogContent>
    </Dialog>
  </>;
}
