<script lang="ts">
	import { gameState } from '$lib/game-state.svelte';
</script>

{#if gameState.hasStartedPlay && !gameState.matchOver && gameState.matchSecondsRemaining !== null}
	<div
		class="pointer-events-none fixed top-8 left-8 z-[90] font-cloud text-4xl text-white text-shadow-gray-400 text-shadow-xs sm:text-5xl"
	>
		{gameState.matchSecondsRemaining}
	</div>
{/if}
