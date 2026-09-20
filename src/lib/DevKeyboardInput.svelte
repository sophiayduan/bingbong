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
		const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
		const button = KEY_TO_BUTTON[key];
		if (!button) return;
		e.preventDefault();
		gameState.simulateButtonPress(devInput.selectedPlayer, button);
	}
</script>

<svelte:window onkeydown={handleKeydown} />


