import { describe, expect, it } from 'vitest';
import {
  findValidFiscalAccessKey,
  inferSupplierStateFromHeader,
  isValidFiscalAccessKey,
  resolveSupplierIdentity,
} from '../../supabase/functions/read-fiscal-note/fiscalIdentity';

const JUND_DIAMOND_KEY = '35260511770218000141550010000184761314132783';
const B_LUX_KEY = '35260600425361000180550010000404751898637284';

describe('identidade fiscal do emitente na leitura da Edge Function', () => {
  it('obtém SP e o CNPJ correto da chave real da nota Jund Diamond', () => {
    expect(isValidFiscalAccessKey(JUND_DIAMOND_KEY)).toBe(true);
    expect(resolveSupplierIdentity({
      accessKey: JUND_DIAMOND_KEY,
      supplierName: 'JUND DIAMOND COMERCIO DE FERRAMENTAS LTDA',
      supplierCnpj: '05.117.702/0001-41',
      supplierHeaderText: 'Jundiaí/SP CNPJ/CPF 11.770.218/0001-41 DESTINATÁRIO/REMETENTE Porto Velho UF RO',
    })).toEqual({ supplierState: 'SP', supplierCnpj: '11.770.218/0001-41' });
  });

  it('lê SÃO PAULO - SP no cabeçalho real da B Lux', () => {
    expect(resolveSupplierIdentity({
      accessKey: B_LUX_KEY,
      supplierName: 'B LUX MATERIAIS ELETRICOS LTDA',
      supplierCnpj: '00.425.361/0001-80',
      supplierLocationText: 'SÃO PAULO - SP',
      supplierHeaderText: 'B LUX MATERIAIS ELETRICOS LTDA RUA CURITIBA JD. DANTER SÃO PAULO - SP',
    })).toEqual({ supplierState: 'SP', supplierCnpj: '00.425.361/0001-80' });
  });

  it('nunca usa o cUF da chave para substituir a UF escrita no endereço', () => {
    expect(resolveSupplierIdentity({
      accessKey: JUND_DIAMOND_KEY,
      supplierLocationText: 'Curitiba/PR',
    })).toEqual({ supplierState: 'PR', supplierCnpj: '11.770.218/0001-41' });
  });

  it('aceita a chave com espaços e rejeita chave com dígito verificador inválido', () => {
    const spaced = JUND_DIAMOND_KEY.match(/.{1,4}/g)?.join(' ');
    expect(findValidFiscalAccessKey(spaced)).toBe(JUND_DIAMOND_KEY);
    expect(isValidFiscalAccessKey(`${JUND_DIAMOND_KEY.slice(0, -1)}4`)).toBe(false);
  });

  it('usa Jundiaí/SP quando a chave é inválida e ignora Porto Velho/RO do destinatário', () => {
    expect(resolveSupplierIdentity({
      accessKey: `${JUND_DIAMOND_KEY.slice(0, -1)}4`,
      supplierName: 'JUND DIAMOND COMERCIO DE FERRAMENTAS LTDA',
      supplierHeaderText: 'JUND DIAMOND Jundiaí/SP CNPJ/CPF 11.770.218/0001-41 DESTINATÁRIO / REMETENTE Porto Velho UF RO',
    })).toEqual({ supplierState: 'SP', supplierCnpj: '11.770.218/0001-41' });
  });

  it('não pesquisa UF no destinatário, transportador ou local de entrega', () => {
    const text = 'EMITENTE SEM UF DESTINATÁRIO/REMETENTE Porto Velho UF RO TRANSPORTADOR Guarulhos UF SP';
    expect(inferSupplierStateFromHeader(text)).toBeUndefined();
  });

  it('mantém a UF indefinida sem chave válida ou evidência no cabeçalho', () => {
    expect(resolveSupplierIdentity({ supplierHeaderText: 'FORNECEDOR SEM MUNICIPIO OU UF' }))
      .toEqual({ supplierState: undefined, supplierCnpj: undefined });
  });
});
