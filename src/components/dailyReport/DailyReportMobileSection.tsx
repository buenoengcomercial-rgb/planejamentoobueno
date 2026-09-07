import { ChevronDown } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

interface DailyReportMobileSectionProps {
  title: string;
  summary: string;
  children: ReactNode;
  className?: string;
}

/**
 * Keeps the desktop report fully expanded while reducing the initial vertical
 * footprint of secondary sections on touch devices. The content stays mounted
 * so fields do not lose their in-progress values when a section is collapsed.
 */
export function DailyReportMobileSection({
  title,
  summary,
  children,
  className = '',
}: DailyReportMobileSectionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const contentId = useId();

  return (
    <section className={className}>
      <button
        type="button"
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={() => setIsOpen(open => !open)}
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-foreground">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      <div id={contentId} className={isOpen ? 'mt-3 block lg:mt-0' : 'mt-3 hidden lg:mt-0 lg:block'}>
        {children}
      </div>
    </section>
  );
}
