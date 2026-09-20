export type Column = 'arrows' | 'ab';

export type ChartNote = {
	// Seconds since the countdown's GO moment - see rhythm-state.svelte.ts.
	time: number;
	player: number;
	button: 'U' | 'D' | 'L' | 'R' | 'A' | 'B';
};

// U/D/L/R share the left column, A/B share the right - see PlayerLanes.svelte.
export function columnForButton(button: string): Column | undefined {
	if (button === 'U' || button === 'D' || button === 'L' || button === 'R') return 'arrows';
	if (button === 'A' || button === 'B') return 'ab';
	return undefined;
}

// Placeholder chart for exercising the falling-notes pipeline before real
// songs are hand-authored. Notes sit on a quarter-note grid of the 90 BPM
// background beat (see GameState.BEAT_BPM) but aren't spaced evenly on it -
// they come in a groove (see GROOVE below): three notes, a rest, three more,
// a rest, then a run of six, repeating - so it reads as a beat pattern
// rather than a metronome. Quarter notes (60/90 = 0.667s apart) rather than
// something faster so consecutive falling notes have room to clear each
// other visually instead of overlapping in the lane. All four players share
// the same groove (every on-beat step fires a note for every character at
// once); within a single burst a player repeats the same button several
// times in a row (e.g. "U U U") rather than cycling through different ones,
// and it's the burst-to-burst (and player-to-player) button that varies.
const BUTTONS = ['U', 'D', 'L', 'R', 'A', 'B'] as const;
const NUM_PLAYERS = 4;
const BEAT_BPM = 90;
const QUARTER_NOTE_SECONDS = 60 / BEAT_BPM;

// Each entry is a burst of consecutive on-steps (all the same button, per
// player) followed by silent (rest) steps, all measured in quarter notes.
const GROOVE = [
	{ notes: 3, restSteps: 2 },
	{ notes: 3, restSteps: 2 },
	{ notes: 6, restSteps: 3 }
];
const CYCLES = 5;

type Burst = { startStep: number; notes: number };

const BURSTS: Burst[] = (() => {
	const bursts: Burst[] = [];
	let cursor = 0;
	for (let cycle = 0; cycle < CYCLES; cycle++) {
		for (const { notes, restSteps } of GROOVE) {
			bursts.push({ startStep: cursor, notes });
			cursor += notes + restSteps;
		}
	}
	return bursts;
})();

export const DEMO_CHART: ChartNote[] = BURSTS.flatMap((burst, burstIndex) =>
	Array.from({ length: NUM_PLAYERS }, (_, p) => {
		const button = BUTTONS[(burstIndex + p) % BUTTONS.length];
		return Array.from({ length: burst.notes }, (_, n) => ({
			time: 2 + (burst.startStep + n) * QUARTER_NOTE_SECONDS,
			player: p + 1,
			button
		}));
	}).flat()
);
