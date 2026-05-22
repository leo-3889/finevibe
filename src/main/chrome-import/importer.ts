import { session } from 'electron';
import {
  BROWSER_DEFAULT_PARTITION,
  type ChromeImportOptions,
  type ChromeImportProgress,
  type ChromeImportResult,
  type ChromeProfile,
} from '../../shared/types';
import { chromeProfileDir, chromeUserDataDir } from './paths';
import { listProfiles as listProfilesImpl } from './profiles';
import { snapshotProfile } from './copy';
import { readCookies } from './cookies';
import { resetDecryptCache } from './decrypt';

export type ProgressFn = (p: ChromeImportProgress) => void;

export function listProfiles(): ChromeProfile[] {
  return listProfilesImpl();
}

export async function runImport(
  options: ChromeImportOptions,
  onProgress: ProgressFn,
): Promise<ChromeImportResult> {
  const errors: string[] = [];
  let cookieCount = 0;
  let skippedV11 = 0;

  resetDecryptCache();

  const userDataDir = chromeUserDataDir();
  if (!userDataDir) {
    onProgress({ stage: 'error', message: 'Chrome installation not found' });
    return { ok: false, cookieCount: 0, skippedV11: 0, errors: ['Chrome not found'] };
  }

  const profileDir = chromeProfileDir(userDataDir, options.profileId);
  onProgress({ stage: 'starting' });
  onProgress({ stage: 'copy' });

  const snap = snapshotProfile(profileDir);
  try {
    if (snap.cookiesPath) {
      try {
        const { records, skippedV11: ck } = readCookies(snap.cookiesPath);
        skippedV11 += ck;
        onProgress({ stage: 'cookies', done: 0, total: records.length });
        const sess = session.fromPartition(BROWSER_DEFAULT_PARTITION, { cache: true });
        const results = await Promise.allSettled(
          records.map(async (r, i) => {
            await sess.cookies.set(r);
            if (i % 25 === 0) {
              onProgress({ stage: 'cookies', done: i + 1, total: records.length });
            }
          }),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') cookieCount++;
          else errors.push(String(r.reason));
        }
        onProgress({ stage: 'cookies', done: records.length, total: records.length });
      } catch (err) {
        errors.push(`Cookies: ${(err as Error).message}`);
      }
    } else {
      errors.push('Cookies database not found in selected profile');
    }
  } finally {
    snap.cleanup();
  }

  onProgress({ stage: 'done', skippedV11, errors: errors.length });

  return { ok: errors.length === 0, cookieCount, skippedV11, errors };
}

export async function clearImportedCookies(): Promise<void> {
  const sess = session.fromPartition(BROWSER_DEFAULT_PARTITION, { cache: true });
  await sess.clearStorageData({ storages: ['cookies'] });
}

export async function getCookieCount(): Promise<number> {
  const sess = session.fromPartition(BROWSER_DEFAULT_PARTITION, { cache: true });
  const cookies = await sess.cookies.get({});
  return cookies.length;
}
