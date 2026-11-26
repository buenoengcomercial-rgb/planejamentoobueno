import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  upsert: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: 'fiscal-1' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: mocks.rows, error: null }) }) }) }),
      upsert: mocks.upsert,
    }),
    storage: { from: () => ({
      upload: mocks.upload,
      remove: mocks.remove,
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://example.test/${path}` } }),
    }) },
  },
}));

import { FiscalNotes } from './FiscalNotes';

describe('apontamentos da Fiscalização', () => {
  beforeEach(() => {
    mocks.rows = [];
    mocks.upsert.mockReset();
    mocks.upload.mockReset();
    mocks.remove.mockReset();
  });

  it('mostra o registro separado e impede edição quando está em consulta', async () => {
    mocks.rows = [{ id: 'note-1', author_id: 'fiscal-1', note: 'Acesso ao P5 obstruído', photos: [], updated_at: '2026-11-26T10:00:00Z' }];
    render(<FiscalNotes projectId="project-1" date="2026-11-26" canWrite={false} />);
    expect(await screen.findByText('Acesso ao P5 obstruído')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar apontamento' })).not.toBeInTheDocument();
  });

  it('salva o texto somente na tabela da Fiscalização', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 'note-1', author_id: 'fiscal-1', note: 'Verificar quadro', photos: [], updated_at: '2026-11-26T10:00:00Z' }, error: null });
    mocks.upsert.mockReturnValue({ select: () => ({ single }) });
    render(<FiscalNotes projectId="project-1" date="2026-11-26" canWrite />);
    const field = await screen.findByPlaceholderText('Registre o apontamento da fiscalização...');
    fireEvent.change(field, { target: { value: 'Verificar quadro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar apontamento' }));
    await waitFor(() => expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'project-1', report_date: '2026-11-26', author_id: 'fiscal-1', note: 'Verificar quadro' }),
      { onConflict: 'project_id,report_date,author_id' },
    ));
    await waitFor(() => expect(screen.getAllByText('Verificar quadro').length).toBe(2));
  });

  it('não registra foto quando o envio ao armazenamento falha', async () => {
    mocks.upload.mockResolvedValue({ error: new Error('Falha no armazenamento') });
    render(<FiscalNotes projectId="project-1" date="2026-11-26" canWrite />);
    const input = await screen.findByLabelText('Adicionar fotos da fiscalização');
    fireEvent.change(input, { target: { files: [new File(['imagem'], 'foto.jpg', { type: 'image/jpeg' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Falha no armazenamento');
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
