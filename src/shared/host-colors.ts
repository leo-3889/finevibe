// Host identity colors (per-host providers plan §5, T1: data + palette only;
// the UI application lands with T4). Pure JS — shared between main (record
// creation) and the renderer (style-attribute gate, plan §7: the renderer
// never injects a raw string, every color passes the regex first).

/** 8 curated hexes, mid-saturation so each reads on the dark and the light
 *  theme. Local is NOT in the palette: it keeps the fixed neutral
 *  `--text-muted` (identity, not a peer — plan §5). */
export const HOST_PALETTE: readonly string[] = [
  '#4c9aff', // blue
  '#ff8a4c', // orange
  '#3ecf8e', // green
  '#c792ea', // purple
  '#ffd166', // amber
  '#f4707a', // red
  '#5eead4', // teal
  '#f28ab2', // pink
];

/** Style-attribute-safe gate: exactly `#rrggbb`. */
export function isValidHostColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * Round-robin assignment at host creation (plan §5): the first palette color
 * no existing host uses; once every color is taken, cycle by count so a
 * deleted host's slot is refilled in order.
 */
export function pickHostColor(existing: readonly (string | undefined)[]): string {
  const taken = new Set(existing.filter(isValidHostColor));
  for (const color of HOST_PALETTE) {
    if (!taken.has(color)) return color;
  }
  return HOST_PALETTE[existing.length % HOST_PALETTE.length];
}
