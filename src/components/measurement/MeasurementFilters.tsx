import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CalendarDays, Search } from 'lucide-react';
import type { Project } from '@/types/project';

interface MeasurementFiltersProps {
  project: Project;
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
    <Card className="print:hidden px-3 py-2">
      <div className="flex flex-wrap items-end gap-2">
        <p className="mr-2 pb-2 text-xs font-semibold text-foreground">Filtros</p>

        <FilterField label="Data inicial" icon={<CalendarDays className="w-3 h-3" />}>
          <Input
            className="h-8 w-[150px] text-xs"
            type="date"
            value={effStart}
            disabled={isSnapshotMode}
            onChange={e => setStartDate(e.target.value)}
          />
        </FilterField>

        <FilterField label="Data final" icon={<CalendarDays className="w-3 h-3" />}>
          <Input
            className="h-8 w-[150px] text-xs"
            type="date"
            value={effEnd}
            disabled={isSnapshotMode}
            onChange={e => setEndDate(e.target.value)}
          />
        </FilterField>

        <FilterField label="Capitulo">
          <Select value={chapterFilter} onValueChange={setChapterFilter} disabled={isSnapshotMode}>
            <SelectTrigger className="h-8 w-[230px] text-xs">
              <SelectValue placeholder="Todos os capitulos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os capitulos</SelectItem>
              {project.phases.map(p => (
                <SelectItem key={p.id} value={p.id}>
                  {numbering.get(p.id)} - {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField label="Busca" icon={<Search className="w-3 h-3" />}>
          <Input
            className="h-8 min-w-[260px] flex-1 text-xs"
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
