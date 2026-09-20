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
		class="fixed bottom-6 right-6 z-[110] flex items-center justify-center rounded-lg bg-dark-blue font-jua font-semibold text-white shadow-xl transition hover:bg-light-blue {gameState.isFinalLevel
			? 'px-5 py-2 text-2xl'
			: 'h-14 w-14'}"
	>
		{#if gameState.isFinalLevel}
			Play Again
		{:else}
			<!-- Same arrow used for the rhythm lanes' up/down/left/right notes
			     (see PlayerLanes.svelte) - it points up with no rotation, so
			     90deg clockwise is what "next" points right. -->
			<svg viewBox="0 0 25 26" class="h-8 w-8" style="transform: rotate(90deg);" xmlns="http://www.w3.org/2000/svg">
				<path
					d="M23.7858 10.8206C24.6139 11.6512 24.5528 13.0129 23.6536 13.766L23.5189 13.8788C22.7289 14.5404 21.5655 14.4935 20.8313 13.7705L16.3243 9.33165C15.604 8.6223 14.3907 9.19896 14.4859 10.2054L14.3632 23.6433C14.3532 24.7407 13.4607 25.625 12.3633 25.625H11.7635C10.6518 25.625 9.75339 24.7184 9.76354 23.6067L9.8859 10.2054C9.9811 9.19896 8.7678 8.6223 8.04753 9.33166L3.54045 13.7705C2.80628 14.4935 1.64292 14.5404 0.852935 13.8788L0.715675 13.7638C-0.1826 13.0115 -0.244685 11.6516 0.581303 10.8206L10.7496 0.590372C11.5307 -0.195573 12.802 -0.19654 13.5844 0.588215L23.7858 10.8206Z"
					fill="white"
				/>
			</svg>
		{/if}
	</button>
{/if}
