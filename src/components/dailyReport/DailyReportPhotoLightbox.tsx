import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { DailyReportAttachment } from '@/types/project';
import { usePhotoSrc } from '@/lib/photoUrl';

interface DailyReportPhotoLightboxProps {
  lightbox: DailyReportAttachment | null;
  setLightbox: (p: DailyReportAttachment | null) => void;
}

export function DailyReportPhotoLightbox({ lightbox, setLightbox }: DailyReportPhotoLightboxProps) {
  const src = usePhotoSrc(lightbox);
  return (
    <Dialog open={!!lightbox} onOpenChange={(o) => !o && setLightbox(null)}>
      <DialogContent className="max-w-4xl p-2">
        {lightbox && (
          <div className="space-y-2">
            {src ? (
              <img
                src={src}
                alt={lightbox.caption || lightbox.fileName || 'foto'}
                className="w-full max-h-[75vh] object-contain rounded bg-black"
              />
            ) : (
              <div className="w-full h-[60vh] flex items-center justify-center text-muted-foreground text-sm bg-muted rounded">
                Carregando foto…
              </div>
            )}
            <div className="px-2 pb-1 text-xs space-y-0.5">
              {lightbox.caption && <div className="font-medium">{lightbox.caption}</div>}
              {lightbox.taskName && <div className="text-muted-foreground">{lightbox.taskName}{lightbox.phaseChain ? ` — ${lightbox.phaseChain}` : ''}</div>}
              {lightbox.uploadedAt && <div className="text-muted-foreground">{new Date(lightbox.uploadedAt).toLocaleString('pt-BR')}</div>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
