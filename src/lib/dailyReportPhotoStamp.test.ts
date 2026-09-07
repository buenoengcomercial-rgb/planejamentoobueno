import { describe, expect, it } from 'vitest';
import { formatCoordinates, photoStampLines } from './dailyReportPhotoStamp';

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
});
