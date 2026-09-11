// Windows can spend over 15 seconds initializing protected account stores.
// Both sides of the private handshake must allow the same bounded startup time.
export const OWNER_WORKER_STARTUP_MS = 60000;
