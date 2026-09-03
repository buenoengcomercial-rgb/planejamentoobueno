import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustodyTerm, Project, WarehouseRequisition } from '@/types/project';
import { generateCustodyTermPdf, generateDailyWithdrawalConfirmationPdfs } from './pdf';

const { saveMock, tableMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  tableMock: vi.fn(),
}));

vi.mock('jspdf', () => ({
  default: class MockJsPdf {
    lastAutoTable?: { finalY: number };
    setFontSize() {}
    setFont() {}
    text() {}
    setTextColor() {}
    setDrawColor() {}
    line() {}
    addImage() {}
    addPage() {}
    save = saveMock;
  },
}));

vi.mock('jspdf-autotable', () => ({
  default: (doc: { lastAutoTable?: { finalY: number } }, options: unknown) => {
    tableMock(options);
    doc.lastAutoTable = { finalY: 80 };
  },
}));

const project = { id: 'project-1', name: 'Obra teste' } as Project;

describe('PDF de cautela', () => {
  beforeEach(() => {
    saveMock.mockClear();
    tableMock.mockClear();
  });

  it('gera o PDF de uma cautela legada de equipamento único', () => {
    const legacyTerm: CustodyTerm = {
      id: 'legacy-term',
      number: 'TC-2025-0001',
      createdAt: '2025-01-01T10:00:00.000Z',
      issuedAt: '2025-01-01',
      equipmentId: 'legacy-equipment',
      equipmentName: 'Furadeira antiga',
      equipmentInternalCode: 'EQ-LEGADO',
      workerName: 'Operador antigo',
      status: 'em_uso',
      signatureReceiver: 'data:image/png;base64,AA==',
    };

    expect(() => generateCustodyTermPdf(project, legacyTerm)).not.toThrow();
    expect(tableMock).toHaveBeenCalledWith(expect.objectContaining({
      body: [expect.arrayContaining([expect.stringContaining('EQ-LEGADO'), 'Furadeira antiga'])],
    }));
    expect(saveMock).toHaveBeenCalledWith('termo-TC-2025-0001.pdf');
  });

  it('inclui uma linha para cada equipamento de uma cautela agrupada', () => {
    const groupedTerm: CustodyTerm = {
      id: 'grouped-term',
      number: 'TC-2026-0001',
      createdAt: '2026-08-18T10:00:00.000Z',
      issuedAt: '2026-08-18',
      equipmentId: 'equipment-1',
      equipmentName: 'Furadeira',
      workerName: 'Equipe Alpha',
      status: 'parcial',
      equipments: [
        { equipmentId: 'equipment-1', equipmentName: 'Furadeira', equipmentInternalCode: 'EQ-0001', status: 'devolvido' },
        { equipmentId: 'equipment-2', equipmentName: 'Parafusadeira', equipmentInternalCode: 'EQ-0002', status: 'em_uso' },
      ],
    };

    generateCustodyTermPdf(project, groupedTerm);

    expect(tableMock).toHaveBeenCalledWith(expect.objectContaining({ body: expect.arrayContaining([
      expect.arrayContaining([expect.stringContaining('EQ-0001'), 'Furadeira']),
      expect.arrayContaining([expect.stringContaining('EQ-0002'), 'Parafusadeira']),
    ]) }));
    expect((tableMock.mock.calls[0][0] as { body: unknown[] }).body).toHaveLength(2);
  });
});

function requisition(id: string, receiverName: string, status: WarehouseRequisition['status'] = 'entregue'): WarehouseRequisition {
  return {
    id,
    number: `REQ-${id}`,
    date: '2026-09-03',
    status,
    receiverName,
    warehouseOperator: 'Almoxarife',
    notes: 'Aplicar no pavimento térreo',
    createdAt: '2026-09-03T09:00:00.000Z',
    items: [{ itemKey: id, code: 'MAT-01', description: 'Material teste', unit: 'UN', quantity: 2 }],
  };
}

describe('PDF diário de confirmação de retirada', () => {
  beforeEach(() => {
    saveMock.mockClear();
    tableMock.mockClear();
  });

  it('gera um arquivo por recebedor e ignora requisições não entregues', () => {
    const generated = generateDailyWithdrawalConfirmationPdfs(project, {
      date: '2026-09-03',
      buildingLabel: '3 · Incêndio - Curvo 02',
      requisitions: [requisition('1', 'Ana'), requisition('2', 'Ana'), requisition('3', 'Bia'), requisition('4', 'Rascunho', 'rascunho')],
    });

    expect(generated).toBe(2);
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls.every(([fileName]) => String(fileName).startsWith('confirmacao-retirada-2026-09-03-'))).toBe(true);
    expect(tableMock).toHaveBeenCalledTimes(2);
    expect((tableMock.mock.calls[0][0] as { body: unknown[] }).body).toHaveLength(2);
  });
});
