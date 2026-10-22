import { isMac, isWin } from '../platform';
import * as macDecrypt from './decrypt-mac';
import * as linuxDecrypt from './decrypt-linux';
import * as winDecrypt from './decrypt-win';
import { stripDomainHash } from './domain-hash';

export interface DecryptResult {
  text: string | null;
  skipped: 'v11' | null;
  /**
   * Why the value could not be decrypted because of a key problem
   * (keychain/keyring denial, lookup timeout, master-key failure).
   * P2-48: bounded lookups map to this shape instead of throwing.
   */
  keyError?: string;
}

/**
 * Cross-platform decryption of a Chrome-encrypted blob. Returns text=null and
 * skipped='v11' when the value is encrypted with Chrome 127+ App-Bound
 * Encryption on Windows (which we can't decrypt without privileged access).
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
      if (plain === null) return { text: null, skipped: 'v11' };
      return { text: stripDomainHash(plain, hasDomainHash), skipped: null };
    }
    const plain = linuxDecrypt.decryptValue(encrypted);
    return {
      text: stripDomainHash(plain, hasDomainHash),
      skipped: null,
      keyError: linuxDecrypt.getKeyError() ?? undefined,
    };
  } catch (err) {
    return { text: null, skipped: null, keyError: (err as Error).message };
  }
}

export function resetDecryptCache(): void {
  macDecrypt._resetCache();
  linuxDecrypt._resetCache();
  winDecrypt._resetCache();
}
