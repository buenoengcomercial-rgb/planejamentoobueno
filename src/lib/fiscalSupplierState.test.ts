import { describe, expect, it } from 'vitest';
import { inferSupplierState } from './fiscalSupplierState';

describe('inferSupplierState', () => {
  it('identifica Rondônia pelo cUF da chave de acesso da NF-e', () => {
    const text = 'CHAVE DE ACESSO 1126 0622 7600 7500 0294 5500 0000 0422 4111 2099 6490';
    expect(inferSupplierState(text)).toBe('RO');
  });

  it('prioriza a UF do emitente na chave e não a UF do destinatário', () => {
    const text = 'CHAVE DE ACESSO 3526 0612 3456 7800 0190 5500 1000 0001 2312 3456 7890 DESTINATARIO PORTO VELHO UF RO';
    expect(inferSupplierState(text)).toBe('SP');
  });

  it('usa cidade e sigla próximas ao fornecedor quando não há chave', () => {
    const text = 'COMERCIAL PARANA LTDA Rua A, 10 Curitiba / PR CNPJ 12.345.678/0001-90 DESTINATARIO Porto Velho UF RO';
    expect(inferSupplierState(text, 'COMERCIAL PARANA LTDA', '12.345.678/0001-90')).toBe('PR');
  });

  it('não presume uma UF quando não há evidência', () => {
    expect(inferSupplierState('Documento sem endereço do fornecedor')).toBeUndefined();
  });
});
