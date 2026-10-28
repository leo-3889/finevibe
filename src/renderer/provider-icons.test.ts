/**
 * Provider icon governance gate.
 *
 * Provider icons resolve by id at runtime, by string interpolation, in exactly
 * two renderers: `components/board/board-card.ts` (`icon.src =
 * \`assets/providers/${providerId}.png\``) and `components/tab-bar/tab-list.ts`
 * (the same template in the tab prefix). `scripts/copy-assets.js` copies
 * `src/renderer/assets/providers` verbatim into the package, so this directory
 * is the authority for what a user sees at the 14x14 `.tab-provider-icon` size.
 *
 * Two defects that gate, both shipped on 2026-10-24 when Pi-Bolt was added as
 * the seventh backend:
 *
 *   missing asset   — an id with no `<id>.png`; both renderers set
 *                     `onerror → display:none`, so the tab silently loses its
 *                     provider badge and multi-provider sessions become
 *                     indistinguishable.
 *   duplicated bytes — two ids with byte-identical icons (`pi-bolt.png`
 *                     shipped as a copy of `pi.png`). Nothing throws: the tabs
 *                     render, they just render the same glyph, which is worse
 *                     than a missing one because it looks correct.
 *
 * Id source: the provider registry (`initProviders` + `getAllProviderMetas`)
 * is the shipped runtime data the renderers gate on — `tab-list.ts` only lets
 * a persisted id through when `getCachedProviderMetas()` knows it — so the
 * registry is audited, never restated. The `ProviderId` union in
 * `src/shared/types.ts` is cross-checked by text scan (the `module-map-governance.test.ts`
 * idiom) so a union member added without a registered provider fails here too.
 *
 * PNG contract is signature + IHDR dimensions (bytes 0-7 and the big-endian
 * width/height at 16/20), not full chunk integrity: the gate's job is "a real
 * raster, big enough to survive the 14x14 render, unique per provider".
 * Existing icons range 48x48 to 640x640, so the floor is square + >= 32px.
 */
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, describe, expect, it } from 'vitest';
import { getAllProviderMetas, initProviders } from '../main/providers/registry';

/** Smallest accepted icon; a valid 48x48 single-colour glyph is ~134 bytes. */
export const MIN_ICON_BYTES = 96;
/** Icons are square and at least 2x the 14x14 `.tab-provider-icon` render. */
export const MIN_ICON_PX = 32;
const PNG_SIGNATURE = '89504e470d0a1a0a';
const ICON_SUFFIX = '.png';

export interface ProviderIconAudit {
  /** Provider ids with no `<id>.png` in the asset dir. */
  missing: string[];
  /** Ids whose icon is present but smaller than MIN_ICON_BYTES. */
  trivial: string[];
  /** Ids whose icon is not a square PNG of at least MIN_ICON_PX (or unreadable). */
  malformed: string[];
  /** Groups of >= 2 ids whose icon bytes are byte-for-byte identical. */
  duplicates: string[][];
  /** `<id>.png` files in the asset dir that no provider id owns. */
  orphaned: string[];
}

/** The `ProviderId` string-literal union, as authored in `shared/types.ts`. */
export function parseProviderIdUnion(source: string): string[] {
  const decl = source.match(/^export type ProviderId = ([^;]+);/m);
  return decl ? [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
}

/** PNG signature + IHDR width/height; null when the file is not a readable PNG. */
export function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Audit `assetDir` against `ids`: existence, non-trivial size, PNG shape,
 * byte-uniqueness, and staleness of files nobody owns. Pure and total — a
 * missing directory yields every id as `missing`, it never throws.
 */
export function auditProviderIcons(assetDir: string, ids: string[]): ProviderIconAudit {
  const audit: ProviderIconAudit = { missing: [], trivial: [], malformed: [], duplicates: [], orphaned: [] };
  const digestToIds = new Map<string, string[]>();

  for (const id of [...ids].sort()) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(assetDir, id + ICON_SUFFIX));
    } catch {
      audit.missing.push(id);
      continue;
    }
    if (bytes.length < MIN_ICON_BYTES) audit.trivial.push(id);
    const dims = pngDimensions(bytes);
    if (!dims || dims.width !== dims.height || dims.width < MIN_ICON_PX) audit.malformed.push(id);
    const digest = createHash('sha256').update(bytes).digest('hex');
    digestToIds.set(digest, [...(digestToIds.get(digest) ?? []), id]);
  }

  audit.duplicates = [...digestToIds.values()].filter((group) => group.length > 1).sort();

  const owned = new Set(ids.map((id) => id + ICON_SUFFIX));
  let files: string[];
  try {
    files = readdirSync(assetDir);
  } catch {
    files = [];
  }
  audit.orphaned = files.filter((f) => f.endsWith(ICON_SUFFIX) && !owned.has(f)).sort();
  return audit;
}

const RENDERER_ROOT = fileURLToPath(new URL('.', import.meta.url));
const ASSET_DIR = path.join(RENDERER_ROOT, 'assets', 'providers');
const TYPES_FILE = path.join(RENDERER_ROOT, '..', 'shared', 'types.ts');

// Shipped runtime data, not a restated list: the registry is what the
// renderers' providerId gates are built from.
initProviders();
const registryIds = getAllProviderMetas().map((meta) => meta.id);
const unionIds = parseProviderIdUnion(readFileSync(TYPES_FILE, 'utf8'));
const auditedIds = [...new Set([...registryIds, ...unionIds])].sort();

describe('provider icon assets', () => {
  it('the provider registry and the ProviderId union name the same providers', () => {
    const unregistered = registryIds.filter((id) => !unionIds.includes(id)).sort();
    const untyped = unionIds.filter((id) => !registryIds.includes(id)).sort();
    // An id the registry serves but the union omits is a type hole in the
    // renderers' templates; an id in the union with no provider can never render.
    expect(unregistered, `ProviderId union is missing: ${unregistered.join(', ')}`).toEqual([]);
    expect(untyped, `registry has no provider for: ${untyped.join(', ')}`).toEqual([]);
  });

  it('every provider id owns a distinct, real PNG under assets/providers', () => {
    const audit = auditProviderIcons(ASSET_DIR, auditedIds);
    expect(audit.missing, `No icon asset for: ${audit.missing.join(', ')}`).toEqual([]);
    expect(audit.trivial, `Icon below ${MIN_ICON_BYTES} bytes for: ${audit.trivial.join(', ')}`).toEqual([]);
    expect(audit.malformed, `Icon is not a square PNG of at least ${MIN_ICON_PX}px for: ${audit.malformed.join(', ')}`).toEqual([]);
    expect(
      audit.duplicates,
      `Providers share byte-identical icons (tabs are visually indistinguishable): ${audit.duplicates.map((g) => g.join(' === ')).join(' | ')}`,
    ).toEqual([]);
  });

  it('no icon asset is orphaned from the provider set', () => {
    const audit = auditProviderIcons(ASSET_DIR, auditedIds);
    expect(audit.orphaned, `Icons with no provider id: ${audit.orphaned.join(', ')}`).toEqual([]);
  });

  describe('gate self-tests', () => {
    // Synthetic fixtures in a throwaway dir: these are the gate's own unit
    // tests and the permanent proof that each defect class fails.
    const dirs: string[] = [];
    afterAll(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    /** Minimal PNG-shaped file: real signature + IHDR with these dimensions. */
    function png(width: number, height: number, seed: string, padding = 120): Buffer {
      const ihdr = Buffer.alloc(24);
      Buffer.from(PNG_SIGNATURE, 'hex').copy(ihdr, 0);
      ihdr.writeUInt32BE(13, 8); // IHDR chunk length
      ihdr.write('IHDR', 12);
      ihdr.writeUInt32BE(width, 16);
      ihdr.writeUInt32BE(height, 20);
      return Buffer.concat([ihdr, Buffer.from(seed.padEnd(padding, '.'), 'utf8')]);
    }

    function fixture(icons: Record<string, Buffer>): string {
      const dir = mkdtempSync(path.join(tmpdir(), 'provider-icons-'));
      dirs.push(dir);
      for (const [name, bytes] of Object.entries(icons)) writeFileSync(path.join(dir, name), bytes);
      return dir;
    }

    it('flags a duplicated icon as byte-identical providers', () => {
      const bytes = png(96, 96, 'glyph');
      const audit = auditProviderIcons(fixture({ 'pi.png': bytes, 'pi-bolt.png': bytes }), ['pi', 'pi-bolt']);
      expect(audit.duplicates).toEqual([['pi', 'pi-bolt']]);
      expect(audit.missing).toEqual([]);
    });

    it('flags a provider id with no icon asset', () => {
      const audit = auditProviderIcons(fixture({ 'pi.png': png(48, 48, 'glyph') }), ['pi', 'pi-bolt']);
      expect(audit.missing).toEqual(['pi-bolt']);
    });

    it('flags a trivially small icon', () => {
      const audit = auditProviderIcons(fixture({ 'pi.png': Buffer.alloc(8, 0) }), ['pi']);
      expect(audit.trivial).toEqual(['pi']);
      expect(audit.malformed).toEqual(['pi']);
    });

    it('flags a non-PNG and a non-square icon', () => {
      const audit = auditProviderIcons(
        fixture({ 'pi.png': png(16, 16, 'tiny'), 'pi-bolt.png': Buffer.from('not a png at all, long enough to pass the size floor') }),
        ['pi', 'pi-bolt'],
      );
      expect(audit.malformed).toEqual(['pi', 'pi-bolt']);
    });

    it('flags an icon asset no provider owns', () => {
      const audit = auditProviderIcons(
        fixture({ 'pi.png': png(48, 48, 'glyph'), 'stale-provider.png': png(48, 48, 'old') }),
        ['pi'],
      );
      expect(audit.orphaned).toEqual(['stale-provider.png']);
    });

    it('passes a set of distinct, real-sized icons and reports a clean audit', () => {
      const audit = auditProviderIcons(
        fixture({ 'pi.png': png(48, 48, 'a'), 'pi-bolt.png': png(96, 96, 'b') }),
        ['pi', 'pi-bolt'],
      );
      expect(audit).toEqual({ missing: [], trivial: [], malformed: [], duplicates: [], orphaned: [] });
    });
  });
});
