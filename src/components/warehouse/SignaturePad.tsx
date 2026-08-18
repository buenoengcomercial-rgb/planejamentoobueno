import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Eraser } from 'lucide-react';

interface Props {
  value?: string;
  onChange: (dataUrl: string | undefined) => void;
  label?: string;
  height?: number;
}

export default function SignaturePad({ value, onChange, label, height = 120 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);

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

  return (
    <div className="space-y-1">
      {label && <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>}
      <div className="relative border border-border rounded bg-background">
        {value && !drawing && (
          <img src={value} alt="Assinatura" className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
        )}
        <canvas
          ref={canvasRef}
          className="w-full touch-none cursor-crosshair"
          style={{ height }}
          aria-label={label || 'Área de assinatura'}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
        <Button type="button" size="sm" variant="ghost" className="absolute top-1 right-1 h-6 px-2 text-[10px]" onClick={clear}>
          <Eraser className="w-3 h-3 mr-1" /> Limpar
        </Button>
      </div>
    </div>
  );
}
