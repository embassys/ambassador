export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
