import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-react';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';

interface Props {
  search: string;
  setSearch: (v: string) => void;
  bankFilter: string;
  setBankFilter: (v: string) => void;
  banks: string[];
  showAnalytic: boolean;
  toggleAnalytic: () => void;
  onCollapseAll?: () => void;
  onExpandAll?: () => void;
}

export default function AdditiveFilters({
  search, setSearch, bankFilter, setBankFilter, banks, showAnalytic, toggleAnalytic,
  onCollapseAll, onExpandAll,
}: Props) {
  return (
    <Card className="flex flex-wrap items-center gap-2 p-3">
      <div className="relative w-full min-w-0 flex-1 sm:min-w-[220px]">
        <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por item, código ou descrição..."
          className="min-h-11 pl-7 text-base sm:h-9 sm:min-h-9 sm:text-sm"
        />
      </div>
      <Select value={bankFilter} onValueChange={setBankFilter}>
        <SelectTrigger className="min-h-11 flex-1 text-base sm:h-9 sm:min-h-9 sm:w-[140px] sm:flex-none sm:text-sm"><SelectValue placeholder="Banco" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todos os bancos</SelectItem>
          {banks.map(b => <SelectItem key={b} value={b}>{b}</SelectItem>)}
        </SelectContent>
      </Select>
      {onExpandAll && (
        <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={onExpandAll} title="Expandir todos os capítulos">
          Expandir tudo
        </Button>
      )}
      {onCollapseAll && (
        <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={onCollapseAll} title="Recolher todos os capítulos">
          Recolher tudo
        </Button>
      )}
      <Button
        size="sm"
        className="min-h-11 sm:min-h-9"
        variant={showAnalytic ? 'default' : 'outline'}
        onClick={toggleAnalytic}
      >
        {showAnalytic ? 'Ocultar analítico' : 'Mostrar analítico'}
      </Button>
    </Card>
  );
}
