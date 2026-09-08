import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Eraser, PenLine } from 'lucide-react';

interface Props {
  value?: string;
  onChange: (dataUrl: string | undefined) => void;
  label?: string;
  height?: number;
}

export default function SignaturePad({ value, onChange, label, height = 120 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const focusTimeoutRef = useRef<number | undefined>(undefined);
  const [drawing, setDrawing] = useState(false);
  const [focusPulse, setFocusPulse] = useState(false);

  useEffect(() => () => {
    if (focusTimeoutRef.current !== undefined) window.clearTimeout(focusTimeoutRef.current);
  }, []);

  const ctx = () => canvasRef.current?.getContext('2d') ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width || 400);
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const nextWidth = Math.round(width * ratio);
      const nextHeight = Math.round(height * ratio);
      if (canvas.width === nextWidth && canvas.height === nextHeight) return;
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(canvas);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [height]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = ctx(); if (!c) return;
    const next = point(e);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrawing(true);
    c.lineWidth = 1.8;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = '#111';
    c.beginPath();
    c.moveTo(next.x, next.y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing) return;
    const c = ctx(); if (!c) return;
    const next = point(e);
    c.lineTo(next.x, next.y);
    c.stroke();
  };
  const end = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing) return;
    setDrawing(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const url = canvasRef.current?.toDataURL('image/png');
    if (url) onChange(url);
  };
  const clear = () => {
    const c = ctx(); const cv = canvasRef.current;
    if (c && cv) c.clearRect(0, 0, cv.width, cv.height);
    onChange(undefined);
  };

  const focusSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
    canvas.focus({ preventScroll: true });
    setFocusPulse(true);
    if (focusTimeoutRef.current !== undefined) window.clearTimeout(focusTimeoutRef.current);
    focusTimeoutRef.current = window.setTimeout(() => setFocusPulse(false), 1600);
  };

  return (
    <div className="space-y-1">
      {label && <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>}
      <div className={`overflow-hidden rounded border bg-background transition-shadow ${focusPulse ? 'border-primary ring-2 ring-primary/40' : 'border-border'}`}>
        <div className="flex flex-wrap justify-end gap-1 border-b border-border/60 bg-muted/30 p-1">
          <Button type="button" size="sm" variant="ghost" className="min-h-11 px-3 text-xs" onClick={focusSignature} aria-label="Focar assinatura">
            <PenLine className="mr-1.5 h-4 w-4" /> Focar assinatura
          </Button>
          <Button type="button" size="sm" variant="ghost" className="min-h-11 px-3 text-xs" onClick={clear}>
            <Eraser className="mr-1.5 h-4 w-4" /> Limpar
          </Button>
        </div>
        <div className="relative">
          {value && !drawing && (
            <img src={value} alt="Assinatura" className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
          )}
          <canvas
            ref={canvasRef}
            className="w-full touch-none cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
            style={{ height }}
            tabIndex={0}
            aria-label={label || 'Área de assinatura'}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        </div>
      </div>
    </div>
  );
}
