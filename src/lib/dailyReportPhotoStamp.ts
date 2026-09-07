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
  if (!navigator.geolocation) return { capturedAt, placeLabel };

  const location = await new Promise<DailyReportPhotoLocation | undefined>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      position => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  });

  return { capturedAt, location, placeLabel };
}
