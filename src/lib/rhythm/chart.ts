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
// songs are hand-authored - alternates players/columns/buttons every ~0.45s.
const ARROW_BUTTONS = ['U', 'D', 'L', 'R'] as const;
const AB_BUTTONS = ['A', 'B'] as const;

export const DEMO_CHART: ChartNote[] = Array.from({ length: 48 }, (_, i) => {
	const player = (i % 4) + 1;
	const column: Column = i % 2 === 0 ? 'arrows' : 'ab';
	const button =
		column === 'arrows'
			? ARROW_BUTTONS[Math.floor(i / 2) % ARROW_BUTTONS.length]
			: AB_BUTTONS[Math.floor(i / 2) % AB_BUTTONS.length];
	return { time: 2 + i * 0.45, player, button };
});
