import { EncryptedFileCredentialStore } from "../credential-store.js";
import { CENTRAL_ORIGIN } from "../gateway-application.js";
import type { GatewayPaths } from "../gateway-paths.js";
import { EncryptedFileLocalControlSecretStore } from "../local-control.js";
import { EncryptedFileWebhookSecretStore } from "../webhook-secret-store.js";
import { deriveCredentialKeyIsolated } from "./credential-kdf.js";

export function desktopCredentialStores(paths: GatewayPaths) {
  const options = { deriveKey: deriveCredentialKeyIsolated };
  return {
    credentialStore: new EncryptedFileCredentialStore(
      paths.credentialPath,
      paths.credentialKeyPath,
      JSON.stringify({ centralOrigin: CENTRAL_ORIGIN }),
      options,
    ),
    localControlSecretStore: new EncryptedFileLocalControlSecretStore(
      paths.localControlSecretPath,
      paths.localControlSecretKeyPath,
      options,
    ),
    webhookSecretStore: new EncryptedFileWebhookSecretStore(
      paths.webhookSecretPath,
      paths.webhookSecretKeyPath,
      options,
    ),
  };
}
