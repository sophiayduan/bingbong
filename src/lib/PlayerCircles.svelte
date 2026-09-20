<script lang="ts">
	import { gameState, colorFor, PLAYER_COLORS } from '$lib/game-state.svelte';

	let { big = false }: { big?: boolean } = $props();
</script>

<div class="mt-autow-full h-auto flex items-start justify-start gap-6">
	{#each PLAYER_COLORS as _, i (i)}
		{@const p = gameState.playerStates.get(i + 1)}
		<div class="flex flex-col items-center gap-2">
			<div
				class="flex items-center justify-center rounded-full transition-transform duration-150 {big
					? 'h-36 w-36 text-5xl'
					: 'h-30 w-30 text-3xl'} {p?.flash ? 'scale-110' : 'scale-100'} {p
					? colorFor(i + 1)
					: 'bg-white'}"
			>
				{p ? p.note : ''}
			</div>
			<p class="text-center text-sm">
				{#if p}
					Player {i + 1} · {big ? `button ${p.button} · ${p.time}` : 'joined'}
				{:else}
					open slot
				{/if}
			</p>
		</div>
	{/each}
</div>
