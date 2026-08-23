import { NotImplementedError } from "./errors.js";

export interface ProcessLockOptions {
  pid?: number;
  token?: string;
  isProcessAlive?: (pid: number) => boolean;
}

export class ProcessLock {
  static async acquire(_path: string, _options: ProcessLockOptions = {}): Promise<ProcessLock> {
    throw new NotImplementedError("ProcessLock.acquire");
  }

  async release(): Promise<void> {
    throw new NotImplementedError("ProcessLock.release");
  }
}
