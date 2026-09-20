<script lang="ts">
	import { gameState, MAX_PLAYERS } from '$lib/game-state.svelte';
	import PlayerCircles from '$lib/PlayerCircles.svelte';
</script>

<div class="flex flex-col items-center gap-2 text-center">
	<p class="text-xl font-semibold text-white">Press any button on your device to join!</p>
	<p class="text-sm text-slate-500">
		{gameState.playerStates.size}/{MAX_PLAYERS} joined · starting in {gameState.secondsLeft}s
	</p>
</div>

<PlayerCircles big={false} />

<button
	onclick={() => gameState.goToPlay()}
	class="rounded-sm bg-emerald-500 px-5 py-2.5 font-medium text-white transition hover:bg-emerald-400"
>
	Next →
</button>
