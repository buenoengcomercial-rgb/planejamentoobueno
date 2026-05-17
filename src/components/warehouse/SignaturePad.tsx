import { useRef, useState } from 'react';
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

  const start = (e: React.PointerEvent) => {
    const c = ctx(); if (!c) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    setDrawing(true);
    c.lineWidth = 1.8;
    c.lineCap = 'round';
    c.strokeStyle = '#111';
    c.beginPath();
    c.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing) return;
    const c = ctx(); if (!c) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    c.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    c.stroke();
  };
  const end = () => {
    if (!drawing) return;
    setDrawing(false);
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
          width={400}
          height={height}
          className="w-full touch-none"
          style={{ height }}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
        />
        <Button type="button" size="sm" variant="ghost" className="absolute top-1 right-1 h-6 px-2 text-[10px]" onClick={clear}>
          <Eraser className="w-3 h-3 mr-1" /> Limpar
        </Button>
      </div>
    </div>
  );
}
