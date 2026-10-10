import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CalendarDays, Search } from 'lucide-react';
import type { Project } from '@/types/project';

interface MeasurementFiltersProps {
  project?: Project;
  chapters?: { id: string; name: string }[];
  datesReadOnly?: boolean;
  isSnapshotMode: boolean;
  effStart: string;
  effEnd: string;
  setStartDate: (v: string) => void;
  setEndDate: (v: string) => void;
  chapterFilter: string;
  setChapterFilter: (v: string) => void;
  search: string;
  setSearch: (v: string) => void;
  numbering: Map<string, string>;
}

export default function MeasurementFilters({
  project,
  chapters,
  datesReadOnly = false,
  isSnapshotMode,
  effStart,
  effEnd,
  setStartDate,
  setEndDate,
  chapterFilter,
  setChapterFilter,
  search,
  setSearch,
  numbering,
}: MeasurementFiltersProps) {
  return (
    <Card className="print:hidden border border-border bg-card px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-end gap-2">
        <p className="mr-1 rounded-md bg-muted px-2 py-1 text-[11px] font-semibold text-foreground">Filtros</p>

        <FilterField label="Data inicial" icon={<CalendarDays className="w-3 h-3" />}>
          <Input
            className="h-7 w-[140px] text-xs"
            type="date"
            value={effStart}
            disabled={isSnapshotMode}
            readOnly={datesReadOnly}
            onChange={e => setStartDate(e.target.value)}
          />
        </FilterField>

        <FilterField label="Data final" icon={<CalendarDays className="w-3 h-3" />}>
          <Input
            className="h-7 w-[140px] text-xs"
            type="date"
            value={effEnd}
            disabled={isSnapshotMode}
            readOnly={datesReadOnly}
            onChange={e => setEndDate(e.target.value)}
          />
        </FilterField>

        <FilterField label="Capitulo">
          <Select value={chapterFilter} onValueChange={setChapterFilter} disabled={isSnapshotMode}>
            <SelectTrigger className="h-7 w-[220px] text-xs">
              <SelectValue placeholder="Todos os capitulos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os capitulos</SelectItem>
              {(chapters ?? project?.phases ?? []).map(p => (
                <SelectItem key={p.id} value={p.id}>
                  {numbering.get(p.id)} - {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField label="Busca" icon={<Search className="w-3 h-3" />}>
          <Input
            className="h-7 min-w-[260px] flex-1 text-xs"
            placeholder="Item, codigo, capitulo ou descricao"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </FilterField>
      </div>
    </Card>
  );
}

function FilterField({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
        {icon}
        {label}
      </span>
      {children}
    </label>
  );
}
