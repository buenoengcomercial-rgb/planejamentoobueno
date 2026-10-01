import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SaveStatusIndicator from './SaveStatusIndicator';

describe('SaveStatusIndicator', () => {
  it('só afirma confirmação depois de receber o estado salvo', () => {
    const { rerender } = render(
      <SaveStatusIndicator status="saving" confirmedAt="2026-08-18T18:12:00.000Z" projectId="86593327-d5f7-4c9d-81da-6f23c697b6e2" />,
    );
    expect(screen.getByText('Salvando...')).toBeInTheDocument();
    expect(screen.queryByText('Salvo e conferido na nuvem')).not.toBeInTheDocument();

    rerender(
      <SaveStatusIndicator status="saved" confirmedAt="2026-08-18T18:12:00.000Z" projectId="86593327-d5f7-4c9d-81da-6f23c697b6e2" />,
    );
    expect(screen.getByText('Salvo e conferido na nuvem')).toBeInTheDocument();
    expect(screen.getByText(/Obra 86593327/)).toBeInTheDocument();
  });

  it('diferencia conflito e falta de internet', () => {
    const { rerender } = render(<SaveStatusIndicator status="conflict" />);
    expect(screen.getByText('Atualização em outro aparelho')).toBeInTheDocument();
    rerender(<SaveStatusIndicator status="offline" />);
    expect(screen.getByText('Sem internet')).toBeInTheDocument();
  });

  it('avisa atualizações de outras áreas sem interromper o salvamento atual', () => {
    render(<SaveStatusIndicator status="saved" pendingRemoteAreas={['Almoxarifado', 'Diário de Obra']} />);
    expect(screen.getByText('Atualizações em outras áreas: Almoxarifado, Diário de Obra')).toBeInTheDocument();
  });

  it('distingue reconexão recente de dados possivelmente antigos e da sincronização parcial', () => {
    const recent = new Date().toISOString();
    const { rerender } = render(<SaveStatusIndicator status="saved" confirmedAt={recent} live={false} />);
    expect(screen.getByText('Reconectando · dados conferidos recentemente')).toBeInTheDocument();
    rerender(<SaveStatusIndicator status="saved" confirmedAt="2020-01-01T00:00:00Z" live={false} />);
    expect(screen.getByText('Dados podem estar desatualizados')).toBeInTheDocument();
    rerender(<SaveStatusIndicator status="error" partialSyncPending syncRetrying live={true} />);
    expect(screen.getByText('Sincronização parcial — tentando novamente')).toBeInTheDocument();
    expect(screen.getByText('Atualizado · Tempo real ativo')).toBeInTheDocument();
  });
});
