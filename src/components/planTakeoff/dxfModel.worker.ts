import { dxfModelOnly } from '@/lib/dxfModel';

self.onmessage = async (event: MessageEvent<Blob>) => {
  try {
    const source = await event.data.text();
    self.postMessage({ file: new Blob([dxfModelOnly(source)], { type: 'application/dxf' }) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
