/**
 * Mantém dependências externas estáveis em arquivos cacheáveis sem promover
 * motores pesados de documentos, hoje carregados somente sob demanda.
 */
export function vendorChunkName(id: string): string | undefined {
  const moduleId = id.replace(/\\/g, '/');
  if (!moduleId.includes('/node_modules/')) return undefined;

  if (moduleId.includes('/node_modules/@supabase/') || moduleId.includes('/node_modules/.pnpm/@supabase+')) {
    return 'vendor-cloud';
  }

  return undefined;
}
