import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import Auth from './Auth';
const reload = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, loading: false, error: 'Não foi possível verificar sua sessão.', reload }) }));
it('mostra falha de sessão e permite tentar novamente na tela de login', () => {
  render(<MemoryRouter><Auth /></MemoryRouter>);
  expect(screen.getByRole('alert')).toHaveTextContent('verificar sua sessão');
  fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
  expect(reload).toHaveBeenCalledTimes(1);
});
