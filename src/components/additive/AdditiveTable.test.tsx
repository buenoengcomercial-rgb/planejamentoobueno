import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import AdditiveTable from './AdditiveTable';

describe('AdditiveTable layout', () => {
  it('amplia Item e Und e centraliza os cabeçalhos numéricos', () => {
    const { container } = render(
      <AdditiveTable
        project={{} as Project}
        bdi={0} globalDiscount={0} isLocked={false} showAnalytic={false}
        expanded={new Set()} collapsed={new Set()} filteredComps={[]} groupTree={[]}
        orphanRows={[]} hasEapLink={false}
        onToggleExpand={vi.fn()} onToggleCollapsed={vi.fn()} onUpdateComposition={vi.fn()}
        onReorderComposition={vi.fn()} onUpdateQuantity={vi.fn()} onRemoveComposition={vi.fn()}
        onAddNewService={vi.fn()} onAddNewSubchapter={vi.fn()} onChangeMemory={vi.fn()}
      />,
    );
    const table = container.querySelector('table')!;
    const columns = Array.from(container.querySelectorAll('col'));
    expect(table).toHaveStyle({ minWidth: '1690px' });
    expect(columns[1]).toHaveStyle({ width: '72px' });
    expect(columns[5]).toHaveStyle({ width: '64px' });
    ['Qtd Contratada', 'Qtd Suprimida', 'Qtd Acrescida', 'Qtd Final', 'Valor Unit', '% Var.']
      .forEach(label => expect(Array.from(container.querySelectorAll('th')).find(th => th.textContent === label)).toHaveClass('text-center'));
  });
});
