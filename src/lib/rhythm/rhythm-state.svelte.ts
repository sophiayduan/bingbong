import { gameState } from '$lib/game-state.svelte';
import { columnForButton, type ChartNote, type Column } from './chart';
import { classify, MISS_WINDOW_MS, POINTS } from './judgment';

// Fixed fall duration, top of lane to the hit bar - every note gets the
// same travel time regardless of chart density, so speed reads as constant.
export const NOTE_TRAVEL_MS = 1500;

// Every 10-combo raises the multiplier (capped at x4); a miss resets it -
// this is the only way a miss affects score, since points themselves never
// go down (see GameState.awardPoints).
const MAX_MULTIPLIER = 4;
const COMBO_PER_MULTIPLIER_STEP = 10;

type LiveNote = ChartNote & { id: number };
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
			if (note.button !== button) return;
			const delta = pressMs - note.time * 1000;
			if (Math.abs(delta) < Math.abs(bestDelta)) {
				bestDelta = delta;
				bestIndex = index;
			}
		});
		if (bestIndex === -1 || Math.abs(bestDelta) > MISS_WINDOW_MS) return;

		this.removeNote(player, column, bestIndex);

		const judgment = classify(bestDelta);
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
		this.rafId = requestAnimationFrame(this.tick);
	};

	// Notes that fall past the miss window unhit auto-resolve as misses -
	// this is the only path that breaks combo besides an explicit whiff.
	private sweepMisses() {
		let anyTouched = false;
		const next = new Map(this.queues);
		for (const [player, columns] of next) {
			let playerColumns = columns;
			let playerTouched = false;
			for (const [column, notes] of columns) {
				const stillLive = notes.filter((n) => this.nowMs - n.time * 1000 <= MISS_WINDOW_MS);
				if (stillLive.length === notes.length) continue;
				playerTouched = true;
				playerColumns = new Map(playerColumns);
				playerColumns.set(column, stillLive);
				this.breakCombo(player);
				this.showFeedback(player, 'MISS');
			}
			if (playerTouched) {
				next.set(player, playerColumns);
				anyTouched = true;
			}
		}
		if (anyTouched) this.queues = next;
	}

	private removeNote(player: number, column: Column, index: number) {
		const columns = this.queues.get(player);
		if (!columns) return;
		const notes = columns.get(column) ?? [];
		const nextNotes = notes.slice();
		nextNotes.splice(index, 1);
		const nextColumns = new Map(columns);
		nextColumns.set(column, nextNotes);
		const nextQueues = new Map(this.queues);
		nextQueues.set(player, nextColumns);
		this.queues = nextQueues;
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
