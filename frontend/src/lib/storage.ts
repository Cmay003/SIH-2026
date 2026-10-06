// localStorage can throw (private mode, blocked site data) - the SOS page
// must keep working anyway, so every access is guarded.
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* not persisted - fine for this session */
  }
}
