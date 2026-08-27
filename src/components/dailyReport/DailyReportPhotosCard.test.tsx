import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DailyReportPhotosCard } from './DailyReportPhotosCard';

function renderPhotosCard(handleFiles = vi.fn()) {
  return render(
    <DailyReportPhotosCard
      photos={[]}
      visiblePhotos={[]}
      photosByTask={new Map()}
      photoTaskOptions={[]}
      pendingTaskId="__general__"
      setPendingTaskId={vi.fn()}
      photoFilter="all"
      setPhotoFilter={vi.fn()}
      uploadingCount={0}
      fileInputRef={createRef<HTMLInputElement>()}
      handleFiles={handleFiles}
      updatePhoto={vi.fn()}
      setLightbox={vi.fn()}
      setConfirmDelete={vi.fn()}
    />,
  );
}

describe('DailyReportPhotosCard', () => {
  it('oferece seletores distintos para câmera e galeria', () => {
    const { container } = renderPhotosCard();
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');

    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveAttribute('capture', 'environment');
    expect(inputs[0]).not.toHaveAttribute('multiple');
    expect(inputs[1]).not.toHaveAttribute('capture');
    expect(inputs[1]).toHaveAttribute('multiple');
    expect(screen.getByRole('button', { name: 'Câmera' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Galeria' })).toBeEnabled();
  });

  it('envia fotos da câmera e da galeria pelo mesmo fluxo', () => {
    const handleFiles = vi.fn();
    const { container } = renderPhotosCard(handleFiles);
    const [cameraInput, galleryInput] = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const cameraPhoto = new File(['camera'], 'camera.jpg', { type: 'image/jpeg' });
    const galleryPhoto = new File(['gallery'], 'galeria.jpg', { type: 'image/jpeg' });

    fireEvent.change(cameraInput, { target: { files: [cameraPhoto] } });
    fireEvent.change(galleryInput, { target: { files: [galleryPhoto] } });

    expect(handleFiles).toHaveBeenCalledTimes(2);
    expect(handleFiles.mock.calls[0][0]).toHaveLength(1);
    expect(handleFiles.mock.calls[1][0]).toHaveLength(1);
  });
});
