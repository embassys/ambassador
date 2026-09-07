/** A form suggestion only. Starting the server still checks the actual listener. */
export function suggestedInstancePort(instances: readonly { port: number }[]): number {
  const used = new Set(instances.map((instance) => instance.port));
  let port = 8788;
  while (used.has(port)) port++;
  return port;
}
