import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

const TAG = "invoice-export-sheets";

/**
 * Keeps the device awake during long Google Sheets exports so the OS does not
 * suspend the app when the screen locks mid-request.
 */
export async function runWithScreenStayAwake<T>(fn: () => Promise<T>): Promise<T> {
  let active = false;
  try {
    await activateKeepAwakeAsync(TAG);
    active = true;
  } catch {
    // Web or unsupported: still run the export.
  }
  try {
    return await fn();
  } finally {
    if (active) {
      await deactivateKeepAwake(TAG).catch(() => {});
    }
  }
}
