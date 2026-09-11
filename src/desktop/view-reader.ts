/** One read at a time; replies belong only to the view that requested them. */
export function createViewReader<T>(options: {
  read: () => Promise<T>;
  publish: (value: T) => void;
  failed: (cause: unknown) => void;
  queueRefresh?: boolean;
}): { refresh: () => Promise<void>; close: () => void } {
  let closed = false;
  let reading = false;
  let queued = false;
  return {
    async refresh() {
      if (closed) return;
      if (reading) {
        if (options.queueRefresh) queued = true;
        return;
      }
      reading = true;
      try {
        do {
          queued = false;
          try {
            const value = await options.read();
            if (!closed && !queued) options.publish(value);
          } catch (cause) {
            if (!closed && !queued) options.failed(cause);
          }
        } while (queued && !closed);
      } finally {
        reading = false;
      }
    },
    close() {
      closed = true;
    },
  };
}
