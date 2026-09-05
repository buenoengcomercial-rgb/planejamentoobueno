import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MeasurementValidationPanel from './MeasurementValidationPanel';
import type { ValidationIssue } from '@/lib/measurementValidation';

describe('MeasurementValidationPanel', () => {
  it('aponta a tarefa e os quantitativos da divergência de saldo', () => {
    const issues: ValidationIssue[] = [{
      level: 'error',
      code: 'qty-over-balance',
      message: 'Existem 1 item(ns) com quantidade medida maior que o saldo a executar.',
      affectedTaskIds: ['task-1'],
      affectedTasks: [{
        taskId: 'task-1', itemCode: 'SINAPI 123', description: 'INSTALAÇÃO DE TESTE', unit: 'UN',
        qtyContracted: 10, qtyPriorAccum: 8, qtyPeriod: 3, qtyCurrentAccum: 11,
        qtyBalanceBeforePeriod: 2, qtyExcess: 1,
      }],
    }];

    render(<MeasurementValidationPanel issues={issues} />);

    expect(screen.getByText('SINAPI 123 · INSTALAÇÃO DE TESTE')).toBeInTheDocument();
    expect(screen.getByText(/Contratado: 10 UN/)).toBeInTheDocument();
    expect(screen.getByText(/Acum\. anterior: 8 UN/)).toBeInTheDocument();
    expect(screen.getByText(/Medido agora: 3 UN/)).toBeInTheDocument();
    expect(screen.getByText(/Saldo antes: 2 UN/)).toBeInTheDocument();
  });

  it('mantém avisos sem tarefa específica sem detalhamento adicional', () => {
    render(<MeasurementValidationPanel issues={[{
      level: 'warning',
      code: 'contract-incomplete',
      message: 'Dados contratuais incompletos: BDI.',
    }]} />);

    expect(screen.getByText('Dados contratuais incompletos: BDI.')).toBeInTheDocument();
    expect(screen.queryByText(/Contratado:/)).not.toBeInTheDocument();
  });
});
