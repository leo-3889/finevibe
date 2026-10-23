import { isMac, isWin } from '../platform';
import * as macDecrypt from './decrypt-mac';
import * as linuxDecrypt from './decrypt-linux';
import * as winDecrypt from './decrypt-win';
import { stripDomainHash } from './domain-hash';

export interface DecryptResult {
  text: string | null;
  skipped: 'app-bound' | null;
  /**
   * Why the value could not be decrypted because of a key problem
   * (keychain/keyring denial, lookup timeout, master-key failure).
   * P2-48: bounded lookups map to this shape instead of throwing.
   */
  keyError?: string;
}

/**
 * Cross-platform decryption of a Chrome-encrypted blob. Returns text=null and
 * skipped='app-bound' when the value is encrypted with Chrome App-Bound
 * Encryption — the 'v20' prefix Chrome 127+ writes on Windows, plus any
 * 'v11'-tagged row (Chrome never writes v11 cookies on Windows; both skip
 * because the app-bound key is undecryptable out-of-process).
 * Returns keyError when the platform key is unavailable — the caller reports
 * it instead of silently dropping the row (P2-49).
 */
export function decryptChromeValue(encrypted: Buffer, hasDomainHash: boolean): DecryptResult {
  if (encrypted.length === 0) return { text: '', skipped: null };
  try {
    if (isMac) {
      const plain = macDecrypt.decryptValue(encrypted);
      if (plain === null) {
        return { text: null, skipped: null, keyError: macDecrypt.getKeyError() ?? 'macOS keychain unavailable' };
      }
      return { text: stripDomainHash(plain, hasDomainHash), skipped: null };
    }
    if (isWin) {
      const plain = winDecrypt.decryptValue(encrypted);
      if (plain === null) return { text: null, skipped: 'app-bound' };
      return { text: stripDomainHash(plain, hasDomainHash), skipped: null };
    }
    const plain = linuxDecrypt.decryptValue(encrypted);
    return {
      text: stripDomainHash(plain, hasDomainHash),
      skipped: null,
      keyError: linuxDecrypt.getKeyError() ?? undefined,
    };
  } catch (err) {
    // P2-49: on the Linux throw path (`bad decrypt`) the keyring diagnosis
    // from `getKeyError()` (secret-tool missing/timed out, peanuts fallback)
    // was discarded, so the actionable cause never reached the modal.
    // Keep both: the diagnosis first, the raw failure after it.
    const keyError = [linuxDecrypt.getKeyError(), (err as Error).message].filter(Boolean).join('; ');
    return { text: null, skipped: null, keyError };
  }
}

export function resetDecryptCache(): void {
  macDecrypt._resetCache();
  linuxDecrypt._resetCache();
  winDecrypt._resetCache();
}
