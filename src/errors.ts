export class NotImplementedError extends Error {
  constructor(operation: string) {
    super(`${operation} is not implemented`);
    this.name = "NotImplementedError";
  }
}

export class SidecarError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "SidecarError";
  }
}
