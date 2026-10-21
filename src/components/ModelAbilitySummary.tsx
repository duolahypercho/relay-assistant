import { useEffect, useState } from 'react';
import { api } from '../api';
export default function ModelAbilitySummary({ connection }: { connection: object }) {
  const request = JSON.stringify(connection);
  const [result, setResult] = useState<{
    text: boolean | null;
    tools: boolean | null;
    vision: boolean | null;
    source: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    void api
      .request('/models/capabilities', { method: 'POST', body: request, signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [request]);
  if (!result || (result.tools === null && result.vision === null && result.text !== false))
    return null;
  return (
    <p className="form-note model-ability-summary" aria-live="polite">
      {result.text === false
        ? 'This model does not support chat. Choose another model.'
        : result.tools === false
          ? result.vision === true
            ? 'Chat, photos & documents · Attach a file and ask. Apps and assistant actions need a model with tools.'
            : 'Chat & documents · Attach text, PDF or Office files and ask. Photos, apps and assistant actions need a suitable model.'
          : result.tools === true
            ? `Assistant actions supported${result.vision === true ? ' · Images supported' : result.vision === false ? ' · No image support' : ''}.`
            : result.vision === false
              ? 'No image support. Choose a vision model for photos and computer screenshots.'
              : 'Images supported. Tool support is not reported.'}
    </p>
  );
}
