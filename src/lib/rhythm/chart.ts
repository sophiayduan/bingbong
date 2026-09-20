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
