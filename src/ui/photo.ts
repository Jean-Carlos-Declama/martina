import { useEffect, useState } from 'react';

/**
 * Achica la foto de la cámara (que puede pesar 3-5 MB) a una de 600 px en JPEG, que pesa unos 40-80 KB: así caben
 * miles de productos en el iPad y el respaldo no se vuelve enorme.
 */
export async function shrinkPhoto(file: Blob, maxSide = 600): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('No se pudo preparar la foto.'))), 'image/jpeg', 0.8),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Una dirección temporal para mostrar una foto guardada (se libera sola al dejar de usarse). */
export function useBlobUrl(blob?: Blob): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  return url;
}
