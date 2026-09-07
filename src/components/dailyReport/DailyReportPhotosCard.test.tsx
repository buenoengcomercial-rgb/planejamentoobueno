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
      cameraCaptureState="idle"
      cameraLocationError={undefined}
      fileInputRef={createRef<HTMLInputElement>()}
      handleFiles={handleFiles}
      handleCameraFiles={handleFiles}
      prepareCameraCapture={vi.fn()}
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

  it('envia fotos da câmera pelo fluxo registrado e fotos da galeria pelo fluxo comum', () => {
    const handleFiles = vi.fn();
    const handleCameraFiles = vi.fn();
    const { container } = render(
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
        cameraCaptureState="ready"
        cameraLocationError={undefined}
        fileInputRef={createRef<HTMLInputElement>()}
        handleFiles={handleFiles}
        handleCameraFiles={handleCameraFiles}
        prepareCameraCapture={vi.fn()}
        updatePhoto={vi.fn()}
        setLightbox={vi.fn()}
        setConfirmDelete={vi.fn()}
      />,
    );
    const [cameraInput, galleryInput] = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const cameraPhoto = new File(['camera'], 'camera.jpg', { type: 'image/jpeg' });
    const galleryPhoto = new File(['gallery'], 'galeria.jpg', { type: 'image/jpeg' });

    fireEvent.change(cameraInput, { target: { files: [cameraPhoto] } });
    fireEvent.change(galleryInput, { target: { files: [galleryPhoto] } });

    expect(handleCameraFiles).toHaveBeenCalledWith(expect.objectContaining({ length: 1 }));
    expect(handleFiles).toHaveBeenCalledWith(expect.objectContaining({ length: 1 }));
  });

  it('explica que a localização atual é obrigatória antes da câmera', () => {
    renderPhotosCard();
    expect(screen.getByText('A localização atual do aparelho é obrigatória para fotos da câmera.')).toBeVisible();
  });

  it('solicita a abertura automática da câmera após obter a localização', () => {
    const prepareCameraCapture = vi.fn();
    const { container } = render(
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
        cameraCaptureState="idle"
        cameraLocationError={undefined}
        fileInputRef={createRef<HTMLInputElement>()}
        handleFiles={vi.fn()}
        handleCameraFiles={vi.fn()}
        prepareCameraCapture={prepareCameraCapture}
        updatePhoto={vi.fn()}
        setLightbox={vi.fn()}
        setConfirmDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Câmera' }));

    expect(prepareCameraCapture).toHaveBeenCalledWith(expect.any(Function));
    const openCamera = prepareCameraCapture.mock.calls[0][0] as () => void;
    const cameraInput = container.querySelector<HTMLInputElement>('input[capture="environment"]')!;
    const clickCamera = vi.spyOn(cameraInput, 'click');

    openCamera();

    expect(clickCamera).toHaveBeenCalledOnce();
  });
});
