import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { Equipment, WarehouseAttachment } from '@/types/project';
import { cn } from '@/lib/utils';
import { loadWarehouseAttachmentBlob } from '@/lib/warehouseAttachments';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Info,
  Loader2,
  PackageOpen,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

export type WarehouseTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const toneClasses: Record<WarehouseTone, string> = {
  neutral: 'border-border bg-muted/60 text-foreground',
  info: 'border-primary/25 bg-primary/10 text-primary',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/35 bg-warning/10 text-amber-700 dark:text-warning',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
};

const toneIcons: Record<Exclude<WarehouseTone, 'neutral'>, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

export function WarehouseHelp({ text, label = 'Ver ajuda' }: { text: string; label?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 text-primary" aria-label={label}>
          <HelpCircle className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-w-[calc(100vw-2rem)] text-sm leading-relaxed">
        {text}
      </PopoverContent>
    </Popover>
  );
}

export function WarehouseSectionHeader({
  title,
  description,
  help,
  icon: Icon = PackageOpen,
  actions,
  tone = 'info',
  className,
}: {
  title: string;
  description?: string;
  help?: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  tone?: WarehouseTone;
  className?: string;
}) {
  return (
    <div className={cn('warehouse-section-header flex min-h-16 items-center gap-3 border-b px-3 py-3 sm:px-4', toneClasses[tone], className)}>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-current/20 bg-background/85 shadow-sm" aria-hidden="true">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-bold leading-tight sm:text-lg">{title}</h3>
        {description && <p className="mt-1 text-sm leading-snug text-muted-foreground">{description}</p>}
      </div>
      {help && <WarehouseHelp text={help} label={`Ajuda sobre ${title}`} />}
      {actions}
    </div>
  );
}

export function WarehouseField({
  label,
  optional = false,
  error,
  meta,
  children,
  className,
}: {
  label: string;
  optional?: boolean;
  error?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-invalid'?: boolean }>, error ? { 'aria-invalid': true } : {})
    : children;
  return (
    <label className={cn('warehouse-field block rounded-lg border p-3', error && 'warehouse-field-error', className)}>
      <span className="mb-2 flex min-h-5 items-center gap-2 text-sm font-bold leading-tight">
        <span>{label}</span>
        {optional && <span className="rounded-full border bg-background px-2 py-0.5 text-xs font-semibold text-muted-foreground">Opcional</span>}
        {meta && <span className="ml-auto">{meta}</span>}
      </span>
      {control}
      {error && <span role="alert" className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-destructive"><AlertTriangle className="h-4 w-4" />{error}</span>}
    </label>
  );
}

export function WarehouseStatusBadge({ label, tone = 'neutral', className }: { label: string; tone?: WarehouseTone; className?: string }) {
  const Icon = tone === 'neutral' ? Info : toneIcons[tone];
  return (
    <span className={cn('inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold', toneClasses[tone], className)}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

export function WarehouseEmptyState({
  message,
  hint,
  icon: Icon = PackageOpen,
  className,
}: {
  message: string;
  hint?: string;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div className={cn('warehouse-empty-state flex min-h-28 flex-col items-center justify-center rounded-lg border border-dashed p-5 text-center', className)}>
      <span className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary"><Icon className="h-5 w-5" /></span>
      <strong className="text-sm">{message}</strong>
      {hint && <span className="mt-1 text-sm text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function WarehouseActionBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <>
      <div className="h-32 sm:h-20" aria-hidden="true" />
      <div data-testid="warehouse-action-bar" className={cn('warehouse-action-bar sticky bottom-0 z-20 flex flex-wrap justify-end gap-2 border-t p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))]', className)}>
        {children}
      </div>
    </>
  );
}

type ThumbnailState = { source?: string; status: 'empty' | 'loading' | 'ready' | 'error' };

function firstPhoto(equipment: Equipment): WarehouseAttachment | undefined {
  return equipment.photos?.[0];
}

export function WarehouseEquipmentThumbnail({ equipment, className }: { equipment: Equipment; className?: string }) {
  const attachment = firstPhoto(equipment);
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ThumbnailState>(() => attachment?.dataUrl
    ? { source: attachment.dataUrl, status: 'ready' }
    : attachment ? { status: 'loading' } : { status: 'empty' });

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    let observer: IntersectionObserver | undefined;
    setState(attachment?.dataUrl ? { source: attachment.dataUrl, status: 'ready' } : attachment ? { status: 'loading' } : { status: 'empty' });
    if (!attachment || attachment.dataUrl) return () => { active = false; };

    const load = async () => {
      try {
        const blob = await loadWarehouseAttachmentBlob(attachment);
        objectUrl = URL.createObjectURL(blob);
        if (active) setState({ source: objectUrl, status: 'ready' });
      } catch {
        if (active) setState({ status: 'error' });
      }
    };

    if (typeof IntersectionObserver === 'undefined' || !hostRef.current) {
      void load();
    } else {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer?.disconnect();
          void load();
        }
      }, { rootMargin: '100px' });
      observer.observe(hostRef.current);
    }

    return () => {
      active = false;
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);

  const title = equipment.description || equipment.name;
  return (
    <div ref={hostRef} className={cn('flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-background shadow-sm', className)}>
      {state.status === 'ready' && state.source && <img src={state.source} alt={`Foto de ${title}`} className="h-full w-full object-cover" loading="lazy" decoding="async" />}
      {state.status === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Carregando foto" />}
      {(state.status === 'empty' || state.status === 'error') && <Wrench className="h-5 w-5 text-muted-foreground" aria-label={state.status === 'error' ? 'Foto indisponível' : 'Equipamento sem foto'} />}
    </div>
  );
}
