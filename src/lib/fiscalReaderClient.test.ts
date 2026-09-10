import { describe, expect, it } from 'vitest';
import { fiscalReaderError, reconcileReaderPages, validateFiscalReaderPages } from './fiscalReaderClient';

describe('fiscal reader transport', () => {
  it('preserva o corpo HTTP e identifica o contrato antigo rejeitando pages', async () => {
    const context = new Response(JSON.stringify({ error: 'Envie imagem em data URL ou texto extraido do PDF para leitura por IA.' }), { status: 400 });
    const message = await fiscalReaderError({ message: 'Edge Function returned a non-2xx status code', context });
    expect(message).toContain('Lovable Cloud');
    expect(message).toContain('HTTP 400');
    expect(context.bodyUsed).toBe(false);
  });
  it.each([401, 402, 429, 500])('mostra a causa do serviço para HTTP %s', async status => {
    const message = await fiscalReaderError({ context: new Response(JSON.stringify({ error: 'Causa retornada pelo serviço' }), { status }) });
    expect(message).toContain(`HTTP ${status}`);
    expect(message).toContain('Causa retornada pelo serviço');
  });
  it('não perde diagnóstico quando o corpo não é JSON', async () => {
    expect(await fiscalReaderError({ context: new Response('Bad gateway', { status: 502 }) })).toContain('HTTP 502');
  });
  it('rejeita página vazia, repetida e mais de quatro antes do envio', () => {
    expect(() => validateFiscalReaderPages([])).toThrow();
    expect(() => validateFiscalReaderPages([{ sourceIndex: 0, extractedText: '  ' }])).toThrow(/página 1/);
    const pages = Array.from({ length: 4 }, (_, sourceIndex) => ({ sourceIndex, imageDataUrl: 'data:image/jpeg;base64,Zm90bw==' }));
    expect(() => validateFiscalReaderPages(pages)).not.toThrow();
    expect(() => validateFiscalReaderPages([...pages, pages[0]])).toThrow();
    expect(() => validateFiscalReaderPages([pages[0], pages[0]])).toThrow();
  });
  it('mantém a página sem resposta como falha recuperável', () => {
    const result = reconcileReaderPages([{ sourceIndex: 0 }, { sourceIndex: 1 }], [{ sourceIndex: 0, itemCount: 7, status: 'ready' }]);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ sourceIndex: 1, status: 'failed', itemCount: 0 });
  });
});
