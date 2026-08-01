import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import type { CompGroup } from './types';
import AdditiveGroupRow from './AdditiveGroupRow';

const project = { analyticCompositions: [], budgetItems: [] } as unknown as Project;

const rootGroup: CompGroup = {
  phaseId: 'chapter-2',
  number: '2',
  name: 'INCÊNDIO - PALÁCIO CENTRAL',
  depth: 0,
  rows: [],
  children: [],
  subtotalTotalFonte: 0,
  subtotalContratado: 0,
  subtotalSuprimido: 0,
  subtotalAcrescido: 0,
  subtotalFinal: 0,
  subtotalDiferenca: 0,
};

function renderGroup(group = rootGroup, isLocked = false) {
  const onAddNewSubchapter = vi.fn();
  render(
    <table><tbody>
      <AdditiveGroupRow
        project={project}
        group={group}
        bdi={0}
        globalDiscount={0}
        isLocked={isLocked}
        expanded={new Set()}
        collapsed={new Set()}
        showAnalytic={false}
        onToggleExpand={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onUpdateComposition={vi.fn()}
        onUpdateQuantity={vi.fn()}
        onRemoveComposition={vi.fn()}
        onAddNewService={vi.fn()}
        onAddNewSubchapter={onAddNewSubchapter}
        onChangeMemory={vi.fn()}
      />
    </tbody></table>,
  );
  return onAddNewSubchapter;
}

describe('AdditiveGroupRow', () => {
  it('disponibiliza o ícone somente em capítulos principais editáveis', () => {
    const onAddNewSubchapter = renderGroup();

    fireEvent.click(screen.getByRole('button', { name: /novo subcapítulo em 2 incêndio/i }));

    expect(onAddNewSubchapter).toHaveBeenCalledWith('chapter-2');
  });

  it('não mostra o ícone em subcapítulos ou quando o aditivo está bloqueado', () => {
    const childGroup = { ...rootGroup, phaseId: 'chapter-2-1', number: '2.1', depth: 1 };
    const { rerender } = render(
      <table><tbody>
        <AdditiveGroupRow
          project={project}
          group={childGroup}
          bdi={0}
          globalDiscount={0}
          isLocked={false}
          expanded={new Set()}
          collapsed={new Set()}
          showAnalytic={false}
          onToggleExpand={vi.fn()}
          onToggleCollapsed={vi.fn()}
          onUpdateComposition={vi.fn()}
          onUpdateQuantity={vi.fn()}
          onRemoveComposition={vi.fn()}
          onAddNewService={vi.fn()}
          onAddNewSubchapter={vi.fn()}
          onChangeMemory={vi.fn()}
        />
      </tbody></table>,
    );
    expect(screen.queryByRole('button', { name: /novo subcapítulo/i })).not.toBeInTheDocument();

    rerender(
      <table><tbody>
        <AdditiveGroupRow
          project={project}
          group={rootGroup}
          bdi={0}
          globalDiscount={0}
          isLocked
          expanded={new Set()}
          collapsed={new Set()}
          showAnalytic={false}
          onToggleExpand={vi.fn()}
          onToggleCollapsed={vi.fn()}
          onUpdateComposition={vi.fn()}
          onUpdateQuantity={vi.fn()}
          onRemoveComposition={vi.fn()}
          onAddNewService={vi.fn()}
          onAddNewSubchapter={vi.fn()}
          onChangeMemory={vi.fn()}
        />
      </tbody></table>,
    );
    expect(screen.queryByRole('button', { name: /novo subcapítulo/i })).not.toBeInTheDocument();
  });
});
