/** Automatic capture stopped while an in-flight write was being prepared. */
export class CaptureInterruptedError extends Error {
  constructor() {
    super('Automatic capture was interrupted.');
    this.name = 'CaptureInterruptedError';
  }
}

/** Fail an automatic write when its caller-owned consent window is no longer current. */
export function requireCaptureContinuation(continueCapture?: () => boolean): void {
  if (continueCapture?.() === false) throw new CaptureInterruptedError();
}
