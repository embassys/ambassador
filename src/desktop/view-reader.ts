/** One read at a time; replies belong only to the view that requested them. */
export function createViewReader<T>(options: {
  read: () => Promise<T>;
  publish: (value: T) => void;
  failed: (cause: unknown) => void;
}): { refresh: () => Promise<void>; close: () => void } {
  let closed = false;
  let reading = false;
  return {
    async refresh() {
      if (closed || reading) return;
      reading = true;
      try {
        const value = await options.read();
        if (!closed) options.publish(value);
      } catch (cause) {
        if (!closed) options.failed(cause);
      } finally {
        reading = false;
      }
    },
    close() {
      closed = true;
    },
  };
}
