import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './kit';

/**
 * Lee un código de barras con la cámara de atrás del iPad. Safari no trae lector propio, así que se usa ZXing
 * (funciona sin internet). Si la cámara no está permitida, lo dice y se puede escribir el código a mano.
 */
export default function Scanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [manual, setManual] = useState('');

  useEffect(() => {
    let controls: IScannerControls | undefined;
    let stopped = false;
    const reader = new BrowserMultiFormatReader();
    reader
      .decodeFromConstraints({ video: { facingMode: 'environment' } }, video.current!, (result, _error, c) => {
        if (result && !stopped) {
          stopped = true;
          c.stop();
          navigator.vibrate?.(60);
          onCode(result.getText());
        }
      })
      .then(c => {
        controls = c;
        if (stopped) c.stop();
      })
      .catch(() => setError('No se pudo abrir la cámara. Revisa que la app tenga permiso de usar la cámara (Ajustes del iPad › Safari › Cámara).'));
    return () => {
      stopped = true;
      controls?.stop();
    };
  }, [onCode]);

  return (
    <Modal title="Escanear código" onClose={onClose}>
      {error ? <p className="error-text">{error}</p> : <video ref={video} className="scanner-video" muted playsInline />}
      <p className="hint center">Pon el código de barras dentro del cuadro, con buena luz.</p>
      <form
        className="inline-form"
        onSubmit={e => {
          e.preventDefault();
          if (manual.trim()) onCode(manual.trim());
        }}
      >
        <input inputMode="numeric" placeholder="O escribe el código" value={manual} onChange={e => setManual(e.target.value)} />
        <button className="btn" type="submit" disabled={!manual.trim()}>
          Usar
        </button>
      </form>
    </Modal>
  );
}
