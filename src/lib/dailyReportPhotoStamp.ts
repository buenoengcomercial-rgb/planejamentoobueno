export interface DailyReportPhotoLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export interface DailyReportPhotoStamp {
  capturedAt: string;
  location?: DailyReportPhotoLocation;
  placeLabel?: string;
}

function normalizedForMatch(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

/**
 * Combina o endereço fixo cadastrado no cabeçalho da obra com município/UF
 * sem repetir informações que já estejam registradas no próprio endereço.
 */
export function formatProjectPlaceLabel(location?: string, municipality?: string, state?: string) {
  const fixedLocation = location?.trim();
  const city = municipality?.trim();
  const uf = state?.trim().toUpperCase();
  const locationForMatch = normalizedForMatch(fixedLocation || '');
  const cityIncluded = Boolean(city && locationForMatch.includes(normalizedForMatch(city)));
  const ufIncluded = Boolean(uf && new RegExp(`(^|[^A-Z])${uf}([^A-Z]|$)`, 'i').test(fixedLocation || ''));
  const cityState = [cityIncluded ? undefined : city, ufIncluded ? undefined : uf].filter(Boolean).join('/');

  return [fixedLocation, cityState].filter(Boolean).join(' — ') || undefined;
}

export function formatCoordinates(location: DailyReportPhotoLocation) {
  const latitudeHemisphere = location.latitude >= 0 ? 'N' : 'S';
  const longitudeHemisphere = location.longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(location.latitude).toFixed(6)}° ${latitudeHemisphere}, ${Math.abs(location.longitude).toFixed(6)}° ${longitudeHemisphere}`;
}

export function formatPhotoStampDate(capturedAt: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(capturedAt));
}

export function photoStampLines(stamp: DailyReportPhotoStamp) {
  return [
    formatPhotoStampDate(stamp.capturedAt),
    stamp.location ? formatCoordinates(stamp.location) : 'Localização não disponível',
    stamp.placeLabel,
  ].filter((line): line is string => Boolean(line));
}

export async function requestCameraPhotoStamp(placeLabel?: string): Promise<DailyReportPhotoStamp> {
  const capturedAt = new Date().toISOString();
  if (!window.isSecureContext) throw new Error('A localização exige uma conexão segura (HTTPS).');
  if (!navigator.geolocation) throw new Error('Este navegador não disponibiliza a localização do aparelho.');

  const location = await new Promise<DailyReportPhotoLocation>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      position => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      }),
      error => {
        const message = error.code === error.PERMISSION_DENIED
          ? 'Permita a localização para registrar a foto da câmera.'
          : error.code === error.POSITION_UNAVAILABLE
            ? 'O GPS do celular não está disponível. Ative-o e tente novamente.'
            : 'Não foi possível obter a localização a tempo. Verifique o sinal e tente novamente.';
        reject(new Error(message));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });

  return { capturedAt, location, placeLabel };
}
