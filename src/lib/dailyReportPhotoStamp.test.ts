import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatCoordinates, formatProjectPlaceLabel, photoStampLines, requestCameraPhotoStamp } from './dailyReportPhotoStamp';

describe('dailyReportPhotoStamp', () => {
  it('formata coordenadas no padrão exibido no carimbo de campo', () => {
    expect(formatCoordinates({ latitude: -8.750339, longitude: -63.910549 })).toBe('8.750339° S, 63.910549° W');
  });

  it('inclui data, coordenadas e local da obra no carimbo', () => {
    expect(photoStampLines({
      capturedAt: '2026-09-04T09:33:00-04:00',
      location: { latitude: -8.750339, longitude: -63.910549 },
      placeLabel: 'Porto Velho · RO',
    })).toEqual([
      expect.stringContaining('4 de setembro de 2026'),
      '8.750339° S, 63.910549° W',
      'Porto Velho · RO',
    ]);
  });

  it('usa o endereço fixo da obra e completa apenas a cidade e UF ausentes', () => {
    expect(formatProjectPlaceLabel('Avenida Farquar, 2900', 'Porto Velho', 'RO')).toBe('Avenida Farquar, 2900 — Porto Velho/RO');
    expect(formatProjectPlaceLabel('Avenida Farquar, 2900 — Porto Velho/RO', 'Porto Velho', 'RO')).toBe('Avenida Farquar, 2900 — Porto Velho/RO');
    expect(formatProjectPlaceLabel(undefined, 'Porto Velho', 'RO')).toBe('Porto Velho/RO');
  });

  it('exige posição atual do GPS, sem aceitar posição em cache', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { latitude: -8.750339, longitude: -63.910549, accuracy: 5 },
    } as GeolocationPosition));
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });

    await expect(requestCameraPhotoStamp('Porto Velho · RO')).resolves.toMatchObject({
      location: { latitude: -8.750339, longitude: -63.910549, accuracy: 5 },
    });
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), expect.objectContaining({ enableHighAccuracy: true, maximumAge: 0 }));
  });

  it('interrompe a captura quando a permissão de localização é negada', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => failure({
          code: 1,
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
        } as GeolocationPositionError),
      },
    });

    await expect(requestCameraPhotoStamp()).rejects.toThrow('Permita a localização');
  });

  afterEach(() => vi.restoreAllMocks());
});
