// PA-34: decrypt-{linux,mac,win}.ts each exported an identical stripDomainHash.

/**
 * For Chrome cookie DB schema version >= 24, the decrypted payload is prefixed
 * with a 32-byte SHA-256 domain hash that must be stripped.
 */
export function stripDomainHash(plaintext: Buffer, hasDomainHash: boolean): string {
  if (hasDomainHash && plaintext.length >= 32) {
    return plaintext.subarray(32).toString('utf-8');
  }
  return plaintext.toString('utf-8');
}
