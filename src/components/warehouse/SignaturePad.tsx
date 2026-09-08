import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Eraser, PenLine } from 'lucide-react';

interface Props {
  value?: string;
  onChange: (dataUrl: string | undefined) => void;
  label?: string;
  height?: number;
}

const getCanvasPoint = (canvas: HTMLCanvasElement, event: React.PointerEvent<HTMLCanvasElement>) => {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  // O canvas pode ter sido dimensionado antes do modal terminar a animação.
  // Converta sempre da área realmente exibida para o espaço lógico usado pelo contexto.
  const logicalWidth = Math.max(1, canvas.width / ratio);
  const logicalHeight = Math.max(1, canvas.height / ratio);
  const displayWidth = Math.max(1, rect.width || logicalWidth);
  const displayHeight = Math.max(1, rect.height || logicalHeight);
  return {
    x: (event.clientX - rect.left) * (logicalWidth / displayWidth),
    y: (event.clientY - rect.top) * (logicalHeight / displayHeight),
  };
};

const prepareCanvas = (canvas: HTMLCanvasElement, height: number) => {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, rect.width || 640);
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.round(cssWidth * ratio);
  const pixelHeight = Math.round(height * ratio);

  if (canvas.width !== width || canvas.height !== pixelHeight) {
    canvas.width = width;
    canvas.height = pixelHeight;
  }

  canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0);
};

/** Exporta apenas a área que contém tinta, sem levar o espaço vazio do editor. */
const exportInk = (canvas: HTMLCanvasElement): string | undefined => {
  const context = canvas.getContext('2d');
  if (!context) return canvas.toDataURL('image/png');

  try {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 8) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    // Um contexto limitado/testado pode não expor os pixels mesmo após o traço.
    if (maxX < 0 || maxY < 0) return canvas.toDataURL('image/png');

    const padding = Math.max(8, Math.round(Math.min(canvas.width, canvas.height) * 0.04));
    const cropX = Math.max(0, minX - padding);
    const cropY = Math.max(0, minY - padding);
    const cropRight = Math.min(canvas.width, maxX + padding + 1);
    const cropBottom = Math.min(canvas.height, maxY + padding + 1);
    const cropWidth = Math.max(1, cropRight - cropX);
    const cropHeight = Math.max(1, cropBottom - cropY);
    const cropped = document.createElement('canvas');
    cropped.width = cropWidth;
    cropped.height = cropHeight;
    const croppedContext = cropped.getContext('2d');
    if (!croppedContext) return canvas.toDataURL('image/png');
    croppedContext.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    return cropped.toDataURL('image/png');
  } catch {
    return canvas.toDataURL('image/png');
  }
};

export default function SignaturePad({ value, onChange, label, height = 120 }: Props) {
  const editorCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const focusTimerRef = useRef<number | undefined>(undefined);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorHasInk, setEditorHasInk] = useState(false);

  useEffect(() => () => {
    if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current);
  }, []);

  useEffect(() => {
    if (!editorOpen) return undefined;
    drawingRef.current = false;
    setEditorHasInk(false);
    focusTimerRef.current = window.setTimeout(() => {
      // O conteúdo do Radix é portalizado e pode só receber o tamanho final
      // depois deste efeito. Recalcular aqui evita usar a resolução padrão 300px.
      const canvas = editorCanvasRef.current;
      if (!canvas) return;
      prepareCanvas(canvas, height);
      const context = canvas.getContext('2d');
      context?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.focus({ preventScroll: true });
      canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);

    return () => {
      if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current);
    };
  }, [editorOpen, height]);

  const clearEditor = () => {
    const canvas = editorCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    drawingRef.current = false;
    setEditorHasInk(false);
  };

  const startDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = editorCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const point = getCanvasPoint(canvas, event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawingRef.current = true;
    setEditorHasInk(true);
    context.lineWidth = 1.8;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#111';
    context.beginPath();
    context.moveTo(point.x, point.y);
  };

  const moveDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = editorCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const point = getCanvasPoint(canvas, event);
    context.lineTo(point.x, point.y);
    context.stroke();
  };

  const finishDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const confirmSignature = () => {
    if (!editorHasInk) return;
    const signature = editorCanvasRef.current ? exportInk(editorCanvasRef.current) : undefined;
    if (!signature) return;
    onChange(signature);
    setEditorOpen(false);
  };

  return (
    <div className="space-y-1">
      {label && <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>}
      <div className="overflow-hidden rounded border border-border bg-background">
        <div className="flex flex-wrap justify-end gap-1 border-b border-border/60 bg-muted/30 p-1">
          <Button type="button" size="sm" variant="ghost" className="min-h-11 px-3 text-xs" onClick={() => setEditorOpen(true)} aria-label="Focar assinatura">
            <PenLine className="mr-1.5 h-4 w-4" /> Focar assinatura
          </Button>
          <Button type="button" size="sm" variant="ghost" className="min-h-11 px-3 text-xs" onClick={() => onChange(undefined)} disabled={!value}>
            <Eraser className="mr-1.5 h-4 w-4" /> Limpar
          </Button>
        </div>
        <div className="flex w-full items-center justify-center bg-background p-2" style={{ minHeight: height }} aria-label={label || 'Área de assinatura'}>
          {value ? (
            <img src={value} alt="Assinatura registrada" className="block max-h-full w-full object-contain" style={{ height }} />
          ) : (
            <button type="button" className="flex w-full items-center justify-center rounded border border-dashed border-muted-foreground/40 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary" style={{ height }} onClick={() => setEditorOpen(true)}>
              Clique em “Focar assinatura” para assinar
            </button>
          )}
        </div>
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-2xl max-h-[90dvh] overflow-y-auto p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Assinar{label ? `: ${label}` : ''}</DialogTitle>
            <DialogDescription>Risque somente a assinatura no campo abaixo. Ao confirmar, apenas os traços serão recortados e colocados no campo principal.</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-background p-2">
            <canvas
              ref={editorCanvasRef}
              className="block w-full touch-none cursor-crosshair rounded border border-dashed border-primary/40 bg-white outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
              style={{ height }}
              tabIndex={0}
              aria-label={`${label || 'Área de assinatura'} — editor`}
              onPointerDown={startDrawing}
              onPointerMove={moveDrawing}
              onPointerUp={finishDrawing}
              onPointerCancel={finishDrawing}
            />
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button type="button" variant="outline" className="min-h-11" onClick={clearEditor}>Limpar campo</Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setEditorOpen(false)}>Cancelar</Button>
            <Button type="button" className="min-h-11" disabled={!editorHasInk} onClick={confirmSignature}>Usar assinatura</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
