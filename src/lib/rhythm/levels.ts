import type { ChartNote } from './chart';
import levelsData from './levels.json';

export type LevelConfig = {
	id: string;
	name: string;
	// Size (in quarter notes) of each burst in the groove, in order - bursts
	// are separated by just enough rest to land the next one on a downbeat
	// (see restStepsFor), and the last burst alternates between a left and a
	// right button instead of repeating one (see generateChart). Levels only
	// differ in these sizes: the last burst gets longer level over level
	// (more sustained alternating presses, less rest relative to notes),
	// which is what makes "fast" and "faster" feel faster/harder while every
	// note is still exactly a quarter note apart, same as "normal" - see
	// chart.ts's history for why that spacing is fixed (closer spacing made
	// falling notes visually overlap).
	burstSizes: number[];
	cycles: number;
	// The match clock runs 20s from GO (see GameState.MATCH_DURATION_S) -
	// notes are cut off a bit before that so the last one has already
	// crossed the hit bar and is fading into the ground by the time the
	// clock hits 0, instead of the match ending on a note mid-fall.
	lastNoteCutoffS: number;
};

// levels.json is the data half of this - each entry is just numbers (burst
// sizes, cycle count, cutoff), no game logic. This file is the interpreter:
// it turns that data into an actual ChartNote[], the same shape
// hand-written charts use.
export const LEVELS: LevelConfig[] = levelsData;

const BUTTONS = ['U', 'D', 'L', 'R', 'A', 'B'] as const;
const ARROW_BUTTONS = ['U', 'D', 'L', 'R'] as const; // left column - see columnForButton
const AB_BUTTONS = ['A', 'B'] as const; // right column
const NUM_PLAYERS = 4;
const BEAT_BPM = 90;
const QUARTER_NOTE_SECONDS = 60 / BEAT_BPM;
const BAR_SECONDS = QUARTER_NOTE_SECONDS * 4;

// The background beat (see GameState.startBeatLoop) starts its very first
// downbeat right at GO, with no runway to feel the groove first - so the
// first note instead lands on the *second* downbeat, one full bar later.
const LEAD_IN_S = BAR_SECONDS;

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

// Turns a level config into an actual chart: every burst starts on a
// downbeat, all four players share the same groove, and the last burst in
// each cycle alternates between a left-column (arrows) and a right-column
// (ab) button (e.g. "L A L A L A") instead of repeating one button like the
// earlier bursts do.
export function generateChart(level: LevelConfig): ChartNote[] {
	const bursts = burstsFor(level.burstSizes, level.cycles);
	const alternatingPosition = level.burstSizes.length - 1;
	return bursts
		.flatMap((burst, burstIndex) => {
			const alternates = burstIndex % level.burstSizes.length === alternatingPosition;
			return Array.from({ length: NUM_PLAYERS }, (_, p) => {
				const arrowButton = ARROW_BUTTONS[(burstIndex + p) % ARROW_BUTTONS.length];
				const abButton = AB_BUTTONS[(burstIndex + p) % AB_BUTTONS.length];
				const soloButton = BUTTONS[(burstIndex + p) % BUTTONS.length];
				return Array.from({ length: burst.notes }, (_, n) => ({
					time: LEAD_IN_S + (burst.startStep + n) * QUARTER_NOTE_SECONDS,
					player: p + 1,
					button: alternates ? (n % 2 === 0 ? arrowButton : abButton) : soloButton
				}));
			}).flat();
		})
		.filter((note) => note.time <= level.lastNoteCutoffS);
}

// Precomputed once, keyed by level id, rather than regenerated on every
// countdown - the charts are pure functions of levels.json so there's
// nothing to regenerate.
export const CHARTS_BY_LEVEL: Record<string, ChartNote[]> = Object.fromEntries(
	LEVELS.map((level) => [level.id, generateChart(level)])
);

export const DEFAULT_LEVEL_ID = LEVELS[0].id;
