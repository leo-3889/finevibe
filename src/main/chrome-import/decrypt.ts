import { isMac, isWin } from '../platform';
import * as macDecrypt from './decrypt-mac';
import * as linuxDecrypt from './decrypt-linux';
import * as winDecrypt from './decrypt-win';

export interface DecryptResult {
  text: string | null;
  skipped: 'v11' | null;
}

/**
 * Cross-platform decryption of a Chrome-encrypted blob. Returns text=null and
 * skipped='v11' when the value is encrypted with Chrome 127+ App-Bound
 * Encryption on Windows (which we can't decrypt without privileged access).
 */
export function decryptChromeValue(encrypted: Buffer, hasDomainHash: boolean): DecryptResult {
  if (encrypted.length === 0) return { text: '', skipped: null };
  if (isMac) {
    const plain = macDecrypt.decryptValue(encrypted);
    return { text: macDecrypt.stripDomainHash(plain, hasDomainHash), skipped: null };
  }
  if (isWin) {
    const plain = winDecrypt.decryptValue(encrypted);
    if (plain === null) return { text: null, skipped: 'v11' };
    return { text: winDecrypt.stripDomainHash(plain, hasDomainHash), skipped: null };
  }
  const plain = linuxDecrypt.decryptValue(encrypted);
  return { text: linuxDecrypt.stripDomainHash(plain, hasDomainHash), skipped: null };
}

export function resetDecryptCache(): void {
  macDecrypt._resetCache();
  linuxDecrypt._resetCache();
  winDecrypt._resetCache();
}
