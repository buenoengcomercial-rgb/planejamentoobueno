import { describe, expect, it } from 'vitest';
import { optimizeFiscalPdf, optimizeStorageAttachment } from './attachmentOptimization';
describe('documento fiscal original', () => {
  it('mantém o mesmo arquivo PDF, inclusive texto e assinatura, sem rasterização', async () => {
    const pdf = new File(['%PDF-1.7\n/ByteRange [0 100 200 50]\nTexto fiscal /EmbeddedFiles'], 'nf.pdf', {type:'application/pdf'});
    expect(await optimizeFiscalPdf(pdf)).toBe(pdf);
    expect(await optimizeStorageAttachment(pdf,'nf')).toBe(pdf);
    expect(await optimizeStorageAttachment(pdf,'recibo')).toBe(pdf);
  });
});
