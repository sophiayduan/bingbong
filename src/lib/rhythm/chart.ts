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
// once). Rest lengths are picked so every burst starts on a downbeat - see
// GROOVE's comment. Most bursts repeat the same button several times in a
// row (e.g. "U U U"), but the run of six alternates between a left-column
// (arrows) and a right-column (ab) button instead (e.g. "L A L A L A") -
// see ALTERNATING_GROOVE_POSITION.
const BUTTONS = ['U', 'D', 'L', 'R', 'A', 'B'] as const;
const ARROW_BUTTONS = ['U', 'D', 'L', 'R'] as const; // left column - see columnForButton
const AB_BUTTONS = ['A', 'B'] as const; // right column
const NUM_PLAYERS = 4;
const BEAT_BPM = 90;
const QUARTER_NOTE_SECONDS = 60 / BEAT_BPM;

// Each entry is a burst of consecutive on-steps followed by silent (rest)
// steps, all measured in quarter notes (one bar = 4 steps). The rest
// lengths are chosen so every burst starts exactly on a downbeat: 3+1,
// 3+1, 6+2 steps lands consecutive bursts on steps 0, 4, 8 (bar 1, 2, 3's
// first beat), and 16 steps total per cycle (= 4 bars) puts the next
// cycle's first burst back on a downbeat too.
const GROOVE = [
	{ notes: 3, restSteps: 1 },
	{ notes: 3, restSteps: 1 },
	{ notes: 6, restSteps: 2 }
];
const CYCLES = 2;

// The match clock runs 20s from GO (see GameState.MATCH_DURATION_S) - notes
// are cut off a bit before that so the very last one has already crossed
// the hit bar and is fading into the ground by the time the clock hits 0,
// instead of the match ending on a note still mid-fall.
const LAST_NOTE_CUTOFF_S = 19.5;

// The run of six (the last entry in GROOVE) alternates between the arrows
// (left) and ab (right) columns instead of repeating one button.
const ALTERNATING_GROOVE_POSITION = GROOVE.length - 1;

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

export const DEMO_CHART: ChartNote[] = BURSTS.flatMap((burst, burstIndex) => {
	const alternates = burstIndex % GROOVE.length === ALTERNATING_GROOVE_POSITION;
	return Array.from({ length: NUM_PLAYERS }, (_, p) => {
		const arrowButton = ARROW_BUTTONS[(burstIndex + p) % ARROW_BUTTONS.length];
		const abButton = AB_BUTTONS[(burstIndex + p) % AB_BUTTONS.length];
		const soloButton = BUTTONS[(burstIndex + p) % BUTTONS.length];
		return Array.from({ length: burst.notes }, (_, n) => ({
			time: 2 + (burst.startStep + n) * QUARTER_NOTE_SECONDS,
			player: p + 1,
			button: alternates ? (n % 2 === 0 ? arrowButton : abButton) : soloButton
		}));
	}).flat();
}).filter((note) => note.time <= LAST_NOTE_CUTOFF_S);
