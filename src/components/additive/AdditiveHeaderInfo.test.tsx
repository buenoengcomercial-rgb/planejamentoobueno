import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Additive, Project } from '@/types/project';
import AdditiveHeaderInfo from './AdditiveHeaderInfo';

it('permite informar vigência após a aprovação, antes da contratação', () => {
  const active = { id: 'add-1', status: 'aprovado', compositions: [], importedAt: '2026-11-05' } as Additive;
  const project = { id: 'project-1', name: 'Obra', additives: [active] } as Project;
  render(<AdditiveHeaderInfo project={project} active={active} bdi={0} globalDiscount={0}
    isLocked onProjectChange={vi.fn()} onChangeBdi={vi.fn()} onChangeGlobalDiscount={vi.fn()}
    onUpdateAdditive={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: /Dados do Cabeçalho/i }));
  const date = screen.getByLabelText('Data de Vigência Contratual');
  expect(date).toBeEnabled();
  fireEvent.change(date, { target: { value: '2026-11-05' } });
  expect(screen.getByRole('button', { name: 'Salvar cabeçalho' })).toBeEnabled();
});
