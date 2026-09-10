import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { indikaItems } from '@/test/fixtures/indikaFiscalNote';

let handle: (request: Request) => Promise<Response>;
const fetchMock = vi.fn();
const photo = 'data:image/jpeg;base64,Zm90bw==';
const page = (sourceIndex: number) => ({ sourceIndex, imageDataUrl: photo });
const read = async (body: unknown) => handle(new Request('http://localhost/read-fiscal-note', { method: 'POST', body: JSON.stringify(body) }));
const aiResponse = (pageNumber: number, items = indikaItems.filter(item => item.sourcePageIndex === pageNumber - 1)) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
  pageNumber, totalPages: 2, invoiceNumber: '013758', supplierName: 'Indika', supplierCnpj: '06.177.939/0001-02',
  totalAmount: pageNumber === 1 ? 20617.5 : null, productsAmount: pageNumber === 1 ? 20617.5 : null, items,
}) } }] }), { status: 200 });

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => 'test-key' }, serve: (callback: typeof handle) => { handle = callback; } });
  // Load the actual edge handler with only Deno.env/serve and the AI gateway substituted.
  const modulePath = '../../supabase/functions/read-fiscal-note/index.ts';
  await import(modulePath);
});
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterAll(() => vi.unstubAllGlobals());

describe('read-fiscal-note edge contract', () => {
  it('aceita pages com imagens, lê separadamente e ordena pela numeração impressa', async () => {
    fetchMock.mockResolvedValueOnce(aiResponse(2)).mockResolvedValueOnce(aiResponse(1));
    const response = await read({ pages: [page(0), page(1)] });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.readerVersion).toBe('multipage-v1');
    expect(data.pages.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([1, 2]);
    expect(data.note.items).toHaveLength(30);
    expect(data.note.items[0]).toMatchObject({ productCode: 'ESP PVC1', sourcePageIndex: 1 });
    expect(data.note.items.reduce((sum: number, item: { totalPrice: number }) => sum + item.totalPrice, 0)).toBe(20617.5);
    expect(data.note.productsAmount).toBe(20617.5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) {
      const content = JSON.parse(options.body).messages[1].content;
      expect(content.filter((block: { type: string }) => block.type === 'image_url')).toHaveLength(1);
    }
  });
  it('mantém a página vazia na resposta como falha e preserva a página legível', async () => {
    fetchMock.mockResolvedValueOnce(aiResponse(1));
    const data = await (await read({ pages: [page(0), { sourceIndex: 1, extractedText: '  ' }] })).json();
    expect(data.pages).toHaveLength(2);
    expect(data.pages[1]).toMatchObject({ sourceIndex: 1, status: 'failed', itemCount: 0 });
    expect(data.note.items).toHaveLength(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('retorna erro específico da IA por página e permite repetir apenas a que falhou', async () => {
    fetchMock.mockResolvedValueOnce(aiResponse(1)).mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Rate limit' } }), { status: 429 }));
    const data = await (await read({ pages: [page(0), page(1)] })).json();
    expect(data.note.items).toHaveLength(7);
    expect(data.pages[1]).toMatchObject({ status: 'failed', error: expect.stringContaining('HTTP 429') });
    fetchMock.mockResolvedValueOnce(aiResponse(2));
    const retry = await (await read({ pages: [page(1)] })).json();
    expect(retry.note.items).toHaveLength(23);
    expect(retry.pages[0]).toMatchObject({ sourceIndex: 1, status: 'ready' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('rejeita mais de quatro páginas antes de chamar a IA', async () => {
    expect((await read({ pages: [0, 1, 2, 3, 4].map(page) })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('não substitui quantidade ilegível por uma unidade inventada', async () => {
    fetchMock.mockResolvedValueOnce(aiResponse(1, [{ ...indikaItems[0], quantity: 0 }]));
    const data = await (await read({ pages: [page(0)] })).json();
    expect(data.note.items[0].quantity).toBe(0);
  });
});
