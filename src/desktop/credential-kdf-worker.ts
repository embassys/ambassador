import { deriveCredentialKey } from "../credential-kdf.js";

const deadline = setTimeout(() => process.exit(1), 15_000);
process.once("disconnect", () => process.exit(1));
process.once("message", (value: unknown) => {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 2 ||
    !("key" in value) ||
    !Buffer.isBuffer(value.key) ||
    value.key.length !== 24 ||
    !("salt" in value) ||
    !Buffer.isBuffer(value.salt) ||
    value.salt.length !== 16
  )
    process.exit(1);
  const { key, salt } = value;
  void deriveCredentialKey(key, salt)
    .then((derived) => {
      key.fill(0);
      salt.fill(0);
      if (!process.connected) {
        derived.fill(0);
        process.exit(1);
      }
      process.send?.({ key: derived }, (error) => {
        derived.fill(0);
        clearTimeout(deadline);
        process.exit(error ? 1 : 0);
      });
    })
    .catch(() => {
      key.fill(0);
      salt.fill(0);
      process.exit(1);
    });
});
if (!process.send) process.exit(1);
