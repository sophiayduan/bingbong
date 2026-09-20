import { gameState } from '$lib/game-state.svelte';
import { columnForButton, type ChartNote, type Column } from './chart';
import { classify, MISS_WINDOW_MS, PERFECT_WINDOW_MS, POINTS, type Judgment } from './judgment';

// Fixed fall duration, top of lane to the hit bar - every note gets the
// same travel time regardless of chart density, so speed reads as constant.
export const NOTE_TRAVEL_MS = 1500;

// How far the hit bar sits above the very bottom of the lane (see the
// banner div in PlayerCircles.svelte) - PlayerLanes.svelte scales a note's
// fall against this same value so it visually lands on the bar instead of
// overshooting past it.
export const HIT_LINE_INSET_PX = 40;

// The hit bar's rendered height, in px - sized so it visually spans exactly
// the PERFECT window (one PERFECT_WINDOW_MS of fall on either side of the
// actual hit instant). Shared by PlayerCircles.svelte (draws the bar) and
// hitLineCenterPx below (tells PlayerLanes.svelte where a note should be
// when it's actually judged) so the two can never drift apart - a press
// landing inside the visible bar must land inside the real timing window,
// or hits that look right on screen would silently do nothing.
export function hitBarHeightPx(laneHeightPx: number) {
	const pxPerMs = laneHeightPx / NOTE_TRAVEL_MS;
	return Math.max(10, PERFECT_WINDOW_MS * 2 * pxPerMs);
}

// Where a note sits (top offset, in px) at the exact instant it's judged -
// the vertical center of the hit bar, not its near edge, so the whole
// visible band brackets the real hit window symmetrically.
export function hitLineCenterPx(laneHeightPx: number) {
	return laneHeightPx - HIT_LINE_INSET_PX - hitBarHeightPx(laneHeightPx) / 2;
}

// Every 10-combo raises the multiplier (capped at x4); a miss resets it -
// this is the only way a miss affects score, since points themselves never
// go down (see GameState.awardPoints).
const MAX_MULTIPLIER = 4;
const COMBO_PER_MULTIPLIER_STEP = 10;

// One-shot callouts as a combo crosses these exact thresholds - separate
// from the per-hit PERFECT/GOOD/MISS feedback (see `feedback` below) so a
// milestone can pop bigger and linger longer without racing the next hit's
// text.
const MILESTONES: { at: number; text: string }[] = [
	{ at: 10, text: 'ON FIRE!' },
	{ at: 20, text: 'UNSTOPPABLE!' },
	{ at: 30, text: 'LEGENDARY!' }
];
const MILESTONE_DISPLAY_MS = 900;

// A missed note stays on screen this much longer after MISS_WINDOW_MS so it
// visually keeps falling - past the hit bar, behind the characters, and
// off the bottom of the screen (see layout.css's ground layer) - instead of
// vanishing the instant it's judged. One more full travel time is enough
// distance to clear the screen at the same fall speed. Exported so
// PlayerLanes.svelte can fade the note out over the tail end of this same
// window, timed to finish right as it's actually removed.
export const NOTE_LINGER_MS = NOTE_TRAVEL_MS;
// A hit note lingers just this long instead - enough to play its burst
// animation (see PlayerLanes.svelte) but short enough it reads as "caught",
// not as still falling. Matches Tailwind's duration-300 utility.
export const HIT_RESOLVE_MS = 300;

type LiveNote = ChartNote & { id: number; resolved?: Judgment; resolvedAtMs?: number };
type Feedback = { text: string; id: number };

function emptyColumns(): Map<Column, LiveNote[]> {
	return new Map([
		['arrows', []],
		['ab', []]
	]);
}

class RhythmGame {
	nowMs = $state(0);
	queues = $state<Map<number, Map<Column, LiveNote[]>>>(new Map());
	combos = $state<Map<number, number>>(new Map());
	// Highest combo each player reached, kept even after a miss resets
	// `combos` back to 0 - the results screen reads this once the round
	// ends, so it can't just be derived from the live (already-reset) combo.
	maxCombos = $state<Map<number, number>>(new Map());
	// Consecutive misses, separate from combo - combo already resets to 0 on
	// the first miss, so it can't tell "just whiffed one" from "on a bad
	// streak". Reset by any hit, not just a perfect one (see registerHit).
	missStreaks = $state<Map<number, number>>(new Map());
	feedback = $state<Map<number, Feedback>>(new Map());
	// Combo-milestone callouts (see MILESTONES) - separate map from
	// `feedback` so a milestone's longer-lived banner never gets clobbered
	// by the very next hit's PERFECT/GOOD text.
	milestoneFeedback = $state<Map<number, Feedback>>(new Map());

	private nextNoteId = 0;
	private rafId: number | undefined;
	private songStart = 0;
	private feedbackTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
	private milestoneTimeouts = new Map<number, ReturnType<typeof setTimeout>>();

	start(chart: ChartNote[]) {
		this.stop();
		this.songStart = gameState.now();
		const queues = new Map<number, Map<Column, LiveNote[]>>();
		for (const note of chart) {
			const column = columnForButton(note.button);
			if (!column) continue;
			if (!queues.has(note.player)) queues.set(note.player, emptyColumns());
			queues.get(note.player)!.get(column)!.push({ ...note, id: this.nextNoteId++ });
		}
		this.queues = queues;
		this.combos = new Map();
		this.maxCombos = new Map();
		this.missStreaks = new Map();
		this.feedback = new Map();
		this.milestoneFeedback = new Map();
		this.tick();
	}

	stop() {
		if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
		this.rafId = undefined;
	}

	notesFor(player: number, column: Column): LiveNote[] {
		return this.queues.get(player)?.get(column) ?? [];
	}

	// A press with nothing in range for that column counts as a whiff - same
	// as a note falling through unhit - so mashing outside the window can't
	// dodge a combo break by just not hitting anything.
	tryHit(player: number, button: string, pressAudioSeconds: number) {
		const column = columnForButton(button);
		if (!column) return;
		const queue = this.queues.get(player)?.get(column);

		const pressMs = (pressAudioSeconds - this.songStart) * 1000;
		let bestIndex = -1;
		let bestDelta = Infinity;
		queue?.forEach((note, index) => {
			// Already-resolved notes (hit or auto-missed) are just lingering
			// for their fade/fall-off animation - not eligible to be hit again.
			if (note.button !== button || note.resolved) return;
			const delta = pressMs - note.time * 1000;
			if (Math.abs(delta) < Math.abs(bestDelta)) {
				bestDelta = delta;
				bestIndex = index;
			}
		});
		if (bestIndex === -1 || Math.abs(bestDelta) > MISS_WINDOW_MS) {
			this.registerMiss(player);
			return;
		}

		// Replaces the note object rather than mutating it in place - it's a
		// plain object, not a $state itself, so a mutated property is
		// invisible to the {#each (n.id)} block in PlayerLanes.svelte even
		// after `queues` is reassigned below. A new object for this id is
		// what actually makes the resolved state (and its styling) show up.
		const judgment = classify(bestDelta);
		const nextQueue = queue!.slice();
		nextQueue[bestIndex] = { ...queue![bestIndex], resolved: judgment, resolvedAtMs: this.nowMs };
		const nextColumns = new Map(this.queues.get(player));
		nextColumns.set(column, nextQueue);
		const nextQueues = new Map(this.queues);
		nextQueues.set(player, nextColumns);
		this.queues = nextQueues;

		if (judgment === 'miss') {
			this.registerMiss(player);
			return;
		}
		this.registerHit(player);

		const combo = (this.combos.get(player) ?? 0) + 1;
		const nextCombos = new Map(this.combos);
		nextCombos.set(player, combo);
		this.combos = nextCombos;

		if (combo > (this.maxCombos.get(player) ?? 0)) {
			const nextMax = new Map(this.maxCombos);
			nextMax.set(player, combo);
			this.maxCombos = nextMax;
		}

		const multiplier = Math.min(MAX_MULTIPLIER, 1 + Math.floor(combo / COMBO_PER_MULTIPLIER_STEP));
		gameState.awardPoints(player, POINTS[judgment] * multiplier);
		this.showFeedback(player, judgment === 'perfect' ? 'PERFECT' : 'GOOD');

		const milestone = MILESTONES.find((m) => m.at === combo);
		if (milestone) this.showMilestone(player, milestone.text);
	}

	private tick = () => {
		this.nowMs = (gameState.now() - this.songStart) * 1000;
		this.sweepMisses();
		if (this.allNotesCleared()) {
			gameState.stopBeatLoop();
			this.stop();
			return;
		}
		this.rafId = requestAnimationFrame(this.tick);
	};

	// True once every note has been judged and finished lingering (or the
	// chart had none to begin with) - i.e. nothing left falling on any lane.
	private allNotesCleared(): boolean {
		for (const columns of this.queues.values()) {
			for (const notes of columns.values()) {
				if (notes.length > 0) return false;
			}
		}
		return true;
	}

	// Notes that fall past the miss window unhit auto-resolve as misses -
	// this is the only path that breaks combo besides an explicit whiff.
	// Judging (combo break + feedback) happens once, right at MISS_WINDOW_MS;
	// actually removing the note from the screen happens separately, later,
	// so a hit can play its burst and a miss can keep falling out of view
	// first (see the resolved-based styling in PlayerLanes.svelte).
	private sweepMisses() {
		let anyTouched = false;
		const next = new Map(this.queues);
		for (const [player, columns] of next) {
			let playerColumns = columns;
			let playerTouched = false;
			for (const [column, notes] of columns) {
				// New note objects, not in-place mutation - same reasoning as
				// tryHit: a mutated property on the same object reference
				// never reaches the {#each (n.id)} block in PlayerLanes.svelte.
				let updated = notes;
				notes.forEach((n, i) => {
					if (n.resolved || this.nowMs - n.time * 1000 <= MISS_WINDOW_MS) return;
					if (updated === notes) updated = notes.slice();
					updated[i] = { ...n, resolved: 'miss', resolvedAtMs: this.nowMs };
					this.registerMiss(player);
				});

				const stillOnScreen = updated.filter((n) => {
					if (!n.resolved) return true;
					const lingerMs = n.resolved === 'miss' ? NOTE_LINGER_MS : HIT_RESOLVE_MS;
					return this.nowMs - (n.resolvedAtMs ?? 0) <= lingerMs;
				});
				if (updated === notes && stillOnScreen.length === notes.length) continue;
				playerTouched = true;
				playerColumns = new Map(playerColumns);
				playerColumns.set(column, stillOnScreen);
			}
			if (playerTouched) {
				next.set(player, playerColumns);
				anyTouched = true;
			}
		}
		if (anyTouched) this.queues = next;
	}

	private breakCombo(player: number) {
		if ((this.combos.get(player) ?? 0) === 0) return;
		const next = new Map(this.combos);
		next.set(player, 0);
		this.combos = next;
	}

	private registerMiss(player: number) {
		this.breakCombo(player);
		const next = new Map(this.missStreaks);
		next.set(player, (next.get(player) ?? 0) + 1);
		this.missStreaks = next;
		this.showFeedback(player, 'MISS');
	}

	private registerHit(player: number) {
		if ((this.missStreaks.get(player) ?? 0) === 0) return;
		const next = new Map(this.missStreaks);
		next.set(player, 0);
		this.missStreaks = next;
	}

	private showFeedback(player: number, text: string) {
		const next = new Map(this.feedback);
		next.set(player, { text, id: Math.random() });
		this.feedback = next;
		clearTimeout(this.feedbackTimeouts.get(player));
		this.feedbackTimeouts.set(
			player,
			setTimeout(() => {
				const cleared = new Map(this.feedback);
				cleared.delete(player);
				this.feedback = cleared;
			}, 500)
		);
	}

	private showMilestone(player: number, text: string) {
		const next = new Map(this.milestoneFeedback);
		next.set(player, { text, id: Math.random() });
		this.milestoneFeedback = next;
		clearTimeout(this.milestoneTimeouts.get(player));
		this.milestoneTimeouts.set(
			player,
			setTimeout(() => {
				const cleared = new Map(this.milestoneFeedback);
				cleared.delete(player);
				this.milestoneFeedback = cleared;
			}, MILESTONE_DISPLAY_MS)
		);
	}
}

export const rhythmGame = new RhythmGame();
export type { Column };
