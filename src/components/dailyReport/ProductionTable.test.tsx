import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProductionTable } from './ProductionTable';

describe('ProductionTable', () => {
  it('mantém uma malha fixa de colunas para todos os grupos de produção', () => {
    const { container } = render(<ProductionTable entries={[{
      taskId: 'task-1', taskName: 'Atividade com descrição longa para testar a coluna', unit: 'UN', actualQuantity: 12.5,
    }]} />);

    const table = container.querySelector('table');
    const columns = container.querySelectorAll('colgroup col');

    expect(table).toHaveClass('table-fixed');
    expect(columns).toHaveLength(5);
    expect(columns[0]).toHaveClass('w-[54%]');
    expect(columns[1]).toHaveClass('w-[10%]');
    expect(columns[2]).toHaveClass('w-[12%]');
    expect(within(table!).getByText('12.50')).toHaveClass('text-right', 'tabular-nums');
  });
});
