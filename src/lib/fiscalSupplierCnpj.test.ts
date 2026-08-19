import { describe, expect, it } from 'vitest';
import { formatCnpj, inferSupplierCnpjFromHeader, isValidCnpj, resolveSupplierCnpj } from './fiscalSupplierCnpj';

describe('CNPJ do emitente da nota fiscal', () => {
  const supplier = '11.770.218/0001-41';
  const recipient = '39.973.085/0001-20';

  it('lê o número imediatamente após o campo CNPJ/CPF do cabeçalho', () => {
    const header = `JUND DIAMOND COMERCIO DE FERRAMENTAS LTDA\nCNPJ / CPF\n11770218000141\nNATUREZA DA OPERAÇÃO\nVenda`;
    expect(inferSupplierCnpjFromHeader(header)).toBe(supplier);
  });

  it('prioriza o CNPJ do emitente e rejeita o CNPJ válido do destinatário', () => {
    const header = `EMITENTE JUND DIAMOND\nCNPJ/CPF ${supplier}\nDESTINATARIO K C BUENO\nCNPJ/CPF ${recipient}`;
    expect(resolveSupplierCnpj(header, recipient)).toBe(supplier);
    expect(resolveSupplierCnpj(`EMITENTE JUND DIAMOND ${supplier}`, recipient)).toBeUndefined();
  });

  it('não confunde inscrição estadual, chave de acesso ou número inválido com CNPJ', () => {
    expect(inferSupplierCnpjFromHeader('INSCRIÇÃO ESTADUAL 407500838117 CNPJ/CPF 407500838117')).toBeUndefined();
    expect(formatCnpj('352605117702180001415500100001847614132783')).toBeUndefined();
    expect(isValidCnpj('11.111.111/1111-11')).toBe(false);
  });
});
