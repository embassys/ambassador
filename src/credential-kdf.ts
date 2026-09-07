import { scrypt } from "node:crypto";

export const CREDENTIAL_KDF = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
export function deriveCredentialKey(stateKey: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(stateKey, salt, 32, CREDENTIAL_KDF, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}
