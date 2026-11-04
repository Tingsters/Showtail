import { decodeViewerHtml } from '../src/core/report/viewerCodec.ts';
import { expandViewerIndex, type ViewerIndex } from '../src/core/report/viewerTypes.ts';

/** Read the portable content contract independently of the browser renderer. */
export function readViewer(html: string) {
  const decoded = decodeViewerHtml(html);
  if (!decoded) throw new Error('Expected an embedded lazy viewer payload');
  return {
    index: expandViewerIndex(decoded.index as unknown as ViewerIndex, decoded.texts),
    texts: decoded.texts,
  };
}
