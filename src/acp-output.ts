export class OutputLimitExceeded extends Error {}

/** Bound each NDJSON event, and optionally total output during a new turn. */
export function boundedAcpOutput(
  maximumBytes: number,
  countTotal: () => boolean = () => false,
): TransformStream<Uint8Array, Uint8Array> {
  let eventBytes = 0;
  let totalBytes = 0;
  return new TransformStream({
    transform(chunk, controller) {
      if (countTotal()) totalBytes += chunk.byteLength;
      else totalBytes = 0;
      if (totalBytes > maximumBytes) throw new OutputLimitExceeded();
      for (const byte of chunk) {
        eventBytes += 1;
        if (eventBytes > maximumBytes) throw new OutputLimitExceeded();
        if (byte === 10) eventBytes = 0;
      }
      controller.enqueue(chunk);
    },
  });
}
