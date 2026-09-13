import { describe, expect, it } from 'vitest';
import { vendorChunkName } from '../../build/vendorChunks';

describe('separação estável de bibliotecas externas', () => {
  it.each([
    ['C:/app/node_modules/.pnpm/@supabase+supabase-js@2.108.2/node_modules/@supabase/supabase-js/dist/main/index.js', 'vendor-cloud'],
  ])('direciona %s para %s', (id, expected) => {
    expect(vendorChunkName(id)).toBe(expected);
  });

  it('não antecipa bibliotecas visuais ou motores de documentos', () => {
    expect(vendorChunkName('C:/app/node_modules/.pnpm/@radix-ui+react-dialog@1.1.14/node_modules/@radix-ui/react-dialog/dist/index.mjs')).toBeUndefined();
    expect(vendorChunkName('C:/app/node_modules/.pnpm/@floating-ui+dom@1.7.4/node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs')).toBeUndefined();
    expect(vendorChunkName('C:/app/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).toBeUndefined();
    expect(vendorChunkName('C:/app/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js')).toBeUndefined();
    expect(vendorChunkName('C:/app/node_modules/.pnpm/react-router-dom@6.30.1/node_modules/react-router-dom/dist/index.js')).toBeUndefined();
    expect(vendorChunkName('C:/app/node_modules/.pnpm/@tanstack+react-query@5.83.0/node_modules/@tanstack/react-query/build/modern/index.js')).toBeUndefined();
    expect(vendorChunkName('C:/app/node_modules/.pnpm/jspdf@4.2.1/node_modules/jspdf/dist/jspdf.es.min.js')).toBeUndefined();
    expect(vendorChunkName('C:/app/node_modules/.pnpm/xlsx@0.18.5/node_modules/xlsx/xlsx.mjs')).toBeUndefined();
    expect(vendorChunkName('C:/app/src/pages/Index.tsx')).toBeUndefined();
  });
});
