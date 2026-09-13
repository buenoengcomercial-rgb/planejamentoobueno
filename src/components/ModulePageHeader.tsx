import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface ModulePageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function ModulePageHeader({
  title,
  description,
  eyebrow,
  meta,
  actions,
  className,
}: ModulePageHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow ? <div className="mb-1">{eyebrow}</div> : null}
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        {meta ? <div className="mt-2 text-xs text-muted-foreground">{meta}</div> : null}
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
