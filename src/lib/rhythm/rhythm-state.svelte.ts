import { gameState } from '$lib/game-state.svelte';
import { columnForButton, type ChartNote, type Column } from './chart';
import { classify, MISS_WINDOW_MS, POINTS, type Judgment } from './judgment';

// Fixed fall duration, top of lane to the hit bar - every note gets the
// same travel time regardless of chart density, so speed reads as constant.
export const NOTE_TRAVEL_MS = 1500;

// Every 10-combo raises the multiplier (capped at x4); a miss resets it -
// this is the only way a miss affects score, since points themselves never
// go down (see GameState.awardPoints).
const MAX_MULTIPLIER = 4;
const COMBO_PER_MULTIPLIER_STEP = 10;

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
	feedback = $state<Map<number, Feedback>>(new Map());

	private nextNoteId = 0;
	private rafId: number | undefined;
	private songStart = 0;
	private feedbackTimeouts = new Map<number, ReturnType<typeof setTimeout>>();

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
		this.feedback = new Map();
		this.tick();
	}

	stop() {
		if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
		this.rafId = undefined;
	}

	// Cuts the song short (the match clock hit 0) - stops the tick loop and
	// clears every note off the board immediately, rather than leaving
	// whatever was mid-fall frozen in place.
	end() {
		this.stop();
		this.queues = new Map();
		this.feedback = new Map();
	}

	notesFor(player: number, column: Column): LiveNote[] {
		return this.queues.get(player)?.get(column) ?? [];
	}

	// A press with nothing in range for that column is ignored outright - no
	// penalty, no combo break. Badge latency makes "wrong time" presses
	// common, and harmless mashing between notes shouldn't feel punishing.
	tryHit(player: number, button: string, pressAudioSeconds: number) {
		const column = columnForButton(button);
		if (!column) return;
		const queue = this.queues.get(player)?.get(column);
		if (!queue || queue.length === 0) return;

		const pressMs = (pressAudioSeconds - this.songStart) * 1000;
		let bestIndex = -1;
		let bestDelta = Infinity;
		queue.forEach((note, index) => {
			// Already-resolved notes (hit or auto-missed) are just lingering
			// for their fade/fall-off animation - not eligible to be hit again.
			if (note.button !== button || note.resolved) return;
			const delta = pressMs - note.time * 1000;
			if (Math.abs(delta) < Math.abs(bestDelta)) {
				bestDelta = delta;
				bestIndex = index;
			}
		});
		if (bestIndex === -1 || Math.abs(bestDelta) > MISS_WINDOW_MS) return;

		// Replaces the note object rather than mutating it in place - it's a
		// plain object, not a $state itself, so a mutated property is
		// invisible to the {#each (n.id)} block in PlayerLanes.svelte even
		// after `queues` is reassigned below. A new object for this id is
		// what actually makes the resolved state (and its styling) show up.
		const judgment = classify(bestDelta);
		const nextQueue = queue.slice();
		nextQueue[bestIndex] = { ...queue[bestIndex], resolved: judgment, resolvedAtMs: this.nowMs };
		const nextColumns = new Map(this.queues.get(player));
		nextColumns.set(column, nextQueue);
		const nextQueues = new Map(this.queues);
		nextQueues.set(player, nextColumns);
		this.queues = nextQueues;

		if (judgment === 'miss') {
			this.breakCombo(player);
			this.showFeedback(player, 'MISS');
			return;
		}

		const combo = (this.combos.get(player) ?? 0) + 1;
		const nextCombos = new Map(this.combos);
		nextCombos.set(player, combo);
		this.combos = nextCombos;

		const multiplier = Math.min(MAX_MULTIPLIER, 1 + Math.floor(combo / COMBO_PER_MULTIPLIER_STEP));
		gameState.awardPoints(player, POINTS[judgment] * multiplier);
		this.showFeedback(player, judgment === 'perfect' ? 'PERFECT' : 'GOOD');
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
					this.breakCombo(player);
					this.showFeedback(player, 'MISS');
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
}

export const rhythmGame = new RhythmGame();
export type { Column };
