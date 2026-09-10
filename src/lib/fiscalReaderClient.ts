import type { WarehouseFiscalExtractionPage } from '@/types/project';

export interface FiscalReaderPageInput {
  sourceIndex: number;
  imageDataUrl?: string;
  extractedText?: string;
}

export const FISCAL_READER_VERSION = 'multipage-v1';

export function validateFiscalReaderPages(pages: FiscalReaderPageInput[]) {
  if (!pages.length || pages.length > 4) throw new Error('Envie entre 1 e 4 páginas para leitura.');
  const indices = new Set<number>();
  pages.forEach(page => {
    if (!Number.isInteger(page.sourceIndex) || page.sourceIndex < 0 || page.sourceIndex > 3 || indices.has(page.sourceIndex)) {
      throw new Error('A sequência das páginas é inválida. Selecione os anexos novamente.');
    }
    indices.add(page.sourceIndex);
    if (!page.imageDataUrl?.startsWith('data:image/') && !page.extractedText?.trim()) {
      throw new Error(`A página ${page.sourceIndex + 1} está sem imagem ou texto. Selecione o arquivo novamente.`);
    }
  });
}

/** Preserve the HTTP response body: FunctionsHttpError.message alone hides the cause. */
export async function fiscalReaderError(error: unknown): Promise<string> {
  const failure = error as { message?: string; context?: Response };
  const response = failure?.context;
  const status = response?.status;
  let detail = '';
  try {
    const body = await response?.clone().json();
    detail = typeof body?.error === 'string' ? body.error : body?.error?.message || body?.message || '';
  } catch { /* HTTP status still provides useful diagnostics for non-JSON responses. */ }
  if (status === 400 && /Envie imagem em data URL/i.test(detail)) {
    return `O serviço de leitura ainda não reconhece as páginas enviadas. Atualize o leitor no Lovable Cloud. HTTP 400: ${detail}`;
  }
  const hint = status === 401 || status === 403 ? 'Acesso à leitura recusado. Verifique a sessão e a configuração do leitor.'
    : status === 402 ? 'Créditos da IA esgotados.'
    : status === 429 ? 'Limite de leituras atingido. Tente novamente em instantes.'
    : 'Não foi possível executar a leitura.';
  return `${hint}${status ? ` HTTP ${status}.` : ''} ${detail || failure?.message || ''}`.trim();
}

export function reconcileReaderPages(input: FiscalReaderPageInput[], returned?: WarehouseFiscalExtractionPage[]): WarehouseFiscalExtractionPage[] {
  return input.map(page => {
    const matches = (returned ?? []).filter(result => result.sourceIndex === page.sourceIndex);
    return matches.length === 1 ? matches[0] : {
      sourceIndex: page.sourceIndex, status: 'failed' as const, itemCount: 0,
      error: 'O leitor não retornou um resultado válido para esta página. Repita esta página.',
    };
  }).sort((a, b) => (a.pageNumber ?? a.sourceIndex + 1) - (b.pageNumber ?? b.sourceIndex + 1));
}
