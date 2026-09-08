export type DiagnosticMode = "development" | "production";
export const DESKTOP_LOG_FILE_BYTES = 64 * 1024 * 1024;
export const DESKTOP_LOG_FILES = 16;
export const DESKTOP_LOG_AGE_MS = 7 * 86400000;
export function desktopDiagnosticOptions(mode: DiagnosticMode) {
  return {
    maximumFileBytes: DESKTOP_LOG_FILE_BYTES,
    maximumFiles: DESKTOP_LOG_FILES,
    maximumAgeMs: DESKTOP_LOG_AGE_MS,
    bodyMode: mode === "production" ? ("metadata" as const) : ("detailed" as const),
  };
}
