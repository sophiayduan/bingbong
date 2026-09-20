<script lang="ts">
	import { gameState } from '$lib/game-state.svelte';
	import { devInput } from '$lib/dev-input.svelte';

	const KEY_TO_BUTTON: Record<string, string> = {
		ArrowUp: 'U',
		ArrowDown: 'D',
		ArrowLeft: 'L',
		ArrowRight: 'R',
		a: 'A',
		b: 'B'
	};

	const NAMES = ['Bing', 'Bong', 'Ping', 'Pong'];

	function handleKeydown(e: KeyboardEvent) {
		// Digits 1-4 pick which character the keyboard controls - only one
		// keyboard, so testing is one character at a time.
		if (e.key >= '1' && e.key <= '4') {
			devInput.selectedPlayer = Number(e.key);
			return;
		}
		// Stands in for the D4 switch on the XIAO (see
		// firmware/xiao_espnow_gateway/main/main.c's ACTION_HOME) so the
		// "back to start" behavior can be tested without real hardware.
		if (e.key.toLowerCase() === 'h') {
			gameState.returnToStartScreen();
			return;
		}
		const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
		const button = KEY_TO_BUTTON[key];
		if (!button) return;
		e.preventDefault();
		gameState.simulateButtonPress(devInput.selectedPlayer, button);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	class="pointer-events-none fixed bottom-6 left-1/2 z-[90] -translate-x-1/2 whitespace-nowrap rounded-lg bg-slate-900/70 px-4 py-2 text-center font-jua text-sm text-white/80"
>
	Dev keyboard: arrows = U/D/L/R, A/B keys = A/B - controlling
	<span class="font-semibold text-white">{NAMES[devInput.selectedPlayer - 1]}</span>
	- press 1-4 to switch, h = back to start
</div>
