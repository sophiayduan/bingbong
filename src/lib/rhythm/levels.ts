import type { ChartNote } from './chart';
import levelsData from './levels.json';

export type LevelConfig = {
	id: string;
	name: string;
	// Tempo the background beat (see GameState.startBeatLoop) and this
	// level's own note grid both run at - passed through to startBeatLoop
	// from Countdown.svelte so the music and the falling notes always agree
	// on the beat, whatever this level's speed is.
	bpm: number;
	// How long the match clock runs for this level (see
	// GameState.startMatchTimer) - notes are cut off a bit before this so
	// the last one has already crossed the hit bar and is fading into the
	// ground by the time the clock hits 0 (see CUTOFF_MARGIN_S), instead of
	// the match ending on a note mid-fall.
	durationS: number;
	// Size (in quarter notes) of each burst in the groove, in order - bursts
	// are separated by just enough rest to land the next one on a downbeat
	// (see restStepsFor). Levels differ in these sizes (the last burst gets
	// longer level over level - more sustained alternating presses, less
	// rest relative to notes) as well as bpm/durationS, which is what makes
	// "fast" and "faster" feel faster/harder while every note is still
	// exactly a quarter note apart at whatever this level's bpm is - see
	// chart.ts's history for why that spacing (rather than something
	// tighter) is what's used - closer spacing made falling notes visually
	// overlap.
	burstSizes: number[];
	cycles: number;
	// False: the last burst repeats one left (arrows) button and one right
	// (ab) button alternately, e.g. "L A L A L A" (see generateChart).
	// True: it cycles a left button between BOTH right buttons instead,
	// e.g. "U A U B U A U B" - more distinct buttons to track per burst,
	// used for the higher levels ("more key variations").
	richAlternation: boolean;
};

// How much earlier than durationS the last note is cut off - see
// LevelConfig.durationS.
const CUTOFF_MARGIN_S = 0.5;

// levels.json is the data half of this - each entry is just numbers (burst
// sizes, cycle count, cutoff), no game logic. This file is the interpreter:
// it turns that data into an actual ChartNote[], the same shape
// hand-written charts use.
export const LEVELS: LevelConfig[] = levelsData;

const BUTTONS = ['U', 'D', 'L', 'R', 'A', 'B'] as const;
const ARROW_BUTTONS = ['U', 'D', 'L', 'R'] as const; // left column - see columnForButton
const AB_BUTTONS = ['A', 'B'] as const; // right column
const NUM_PLAYERS = 4;

type Burst = { startStep: number; notes: number };

// After `notes` consecutive steps starting on a downbeat (a multiple of 4
// quarter notes = one bar), this is the smallest rest that lands the *next*
// burst on a downbeat too (0 if `notes` is itself a multiple of 4).
function restStepsFor(notes: number): number {
	return (4 - (notes % 4)) % 4;
}

function burstsFor(burstSizes: number[], cycles: number): Burst[] {
	const bursts: Burst[] = [];
	let cursor = 0;
	for (let cycle = 0; cycle < cycles; cycle++) {
		for (const notes of burstSizes) {
			bursts.push({ startStep: cursor, notes });
			cursor += notes + restStepsFor(notes);
		}
	}
	return bursts;
}

// The button at position n of the alternating burst, for a player whose
// arrow/ab buttons for this burst are arrowButton/ab0/ab1 (ab0 and ab1 are
// A and B, in whichever order this burst/player rotated them to).
// richAlternation=false: "L A L A L A" - the arrow button and just one ab
// button, repeating every 2 notes. richAlternation=true: "U A U B U A U B"
// - the arrow button against BOTH ab buttons in turn, repeating every 4 -
// more distinct buttons to track per burst.
function alternatingButtonFor(
	n: number,
	richAlternation: boolean,
	arrowButton: ChartNote['button'],
	ab0: ChartNote['button'],
	ab1: ChartNote['button']
): ChartNote['button'] {
	if (!richAlternation) return n % 2 === 0 ? arrowButton : ab0;
	const cyclePos = n % 4;
	if (cyclePos === 0 || cyclePos === 2) return arrowButton;
	return cyclePos === 1 ? ab0 : ab1;
}

// Turns a level config into an actual chart: every burst starts on a
// downbeat, all four players share the same groove, and the last burst in
// each cycle alternates between buttons (see alternatingButtonFor) instead
// of repeating one button like the earlier bursts do.
export function generateChart(level: LevelConfig): ChartNote[] {
	const quarterNoteSeconds = 60 / level.bpm;
	// The background beat's very first downbeat lands right at GO, with no
	// runway to feel the groove first - so the first note instead lands on
	// the *second* downbeat, one full bar later.
	const leadInS = quarterNoteSeconds * 4;
	const cutoffS = level.durationS - CUTOFF_MARGIN_S;

	const bursts = burstsFor(level.burstSizes, level.cycles);
	const alternatingPosition = level.burstSizes.length - 1;
	return bursts
		.flatMap((burst, burstIndex) => {
			const alternates = burstIndex % level.burstSizes.length === alternatingPosition;
			return Array.from({ length: NUM_PLAYERS }, (_, p) => {
				const arrowButton = ARROW_BUTTONS[(burstIndex + p) % ARROW_BUTTONS.length];
				const ab0 = AB_BUTTONS[(burstIndex + p) % AB_BUTTONS.length];
				const ab1 = AB_BUTTONS[(burstIndex + p + 1) % AB_BUTTONS.length];
				const soloButton = BUTTONS[(burstIndex + p) % BUTTONS.length];
				return Array.from({ length: burst.notes }, (_, n) => ({
					time: leadInS + (burst.startStep + n) * quarterNoteSeconds,
					player: p + 1,
					button: alternates
						? alternatingButtonFor(n, level.richAlternation, arrowButton, ab0, ab1)
						: soloButton
				}));
			}).flat();
		})
		.filter((note) => note.time <= cutoffS);
}

// Precomputed once, keyed by level id, rather than regenerated on every
// countdown - the charts are pure functions of levels.json so there's
// nothing to regenerate.
export const CHARTS_BY_LEVEL: Record<string, ChartNote[]> = Object.fromEntries(
	LEVELS.map((level) => [level.id, generateChart(level)])
);

export const DEFAULT_LEVEL_ID = LEVELS[0].id;
