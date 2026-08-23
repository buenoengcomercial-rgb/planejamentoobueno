/**
 * Branding/identidade visual da empresa para uso em UI e PDFs.
 * Centraliza nome, dados e logos para facilitar troca futura.
 */
import logoFull from '@/assets/logo-bueno.png';
import logoIcon from '@/assets/logo-bueno-icon.png';

export const company = {
  name: 'BUENO Prevenção a Incêndio',
  productName: 'BUENO Gestor de Obras',
  legalName: 'K. C. BUENO DE GODOY OLIVEIRA LTDA',
  cnpj: '39.973.085/0001-20',
  address: 'Rua Getúlio Vargas, 2533, São Cristóvão',
  city: 'Porto Velho/RO',
  logoFullUrl: logoFull,
  logoIconUrl: logoIcon,
};

/**
 * Carrega a logo como dataURL e devolve dimensões naturais — para inserir em PDF
 * preservando proporção. Resultado é cacheado.
 */
let _cached: Promise<{ dataUrl: string; width: number; height: number } | null> | null = null;
export function loadCompanyLogoForPdf(): Promise<{ dataUrl: string; width: number; height: number } | null> {
  if (_cached) return _cached;
  _cached = (async () => {
    try {
      const res = await fetch(logoFull);
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('logo load fail'));
        img.src = dataUrl;
      });
      return { dataUrl, ...dims };
    } catch {
      return null;
    }
  })();
  return _cached;
}
