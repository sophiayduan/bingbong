<script lang="ts">
	import { gameState } from '$lib/game-state.svelte';

	// The end-of-level "screen" is just the game screen itself - PlayerCircles
	// swaps every player's sprite to its win/lose emote and nudges the winner
	// bigger / losers smaller once gameState.matchOver is true (see
	// finalTopScore there). This component only supplies the one thing that
	// view doesn't have a place for: the button to move on.
	function handleNext() {
		if (gameState.isFinalLevel) {
			gameState.playAgain();
		} else {
			gameState.advanceLevel();
		}
	}
</script>

{#if gameState.matchOver}
	<button
		onclick={handleNext}
		class="fixed bottom-6 right-6 z-[110] rounded-lg bg-dark-blue px-5 py-2 text-2xl font-jua font-semibold text-white shadow-xl transition hover:bg-light-blue"
	>
		{gameState.isFinalLevel ? 'Play Again' : 'Next'}
	</button>
{/if}
