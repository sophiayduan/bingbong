export type Judgment = 'perfect' | 'good' | 'miss';

// The hit bar's rendered height is derived from PERFECT_WINDOW_MS (see
// PlayerLanes.svelte) - pressing while the note is inside that band is what
// the bar visually promises as "perfect".
export const PERFECT_WINDOW_MS = 120;
export const GOOD_WINDOW_MS = 180;
// Beyond this a note is simply missed, and a press this far from any note
// is treated as an empty press rather than a whiff.
export const MISS_WINDOW_MS = 240;

export const POINTS: Record<Judgment, number> = { perfect: 100, good: 50, miss: 0 };

export function classify(deltaMs: number): Judgment {
	const distance = Math.abs(deltaMs);
	if (distance <= PERFECT_WINDOW_MS) return 'perfect';
	if (distance <= GOOD_WINDOW_MS) return 'good';
	return 'miss';
}
