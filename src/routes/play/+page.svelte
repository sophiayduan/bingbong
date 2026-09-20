<script lang="ts">
	import { gameState, colorFor } from '$lib/game-state.svelte';
	import PlayerCircles from '$lib/PlayerCircles.svelte';
</script>

<PlayerCircles big={true} />

{#if gameState.latestAccel}
	<div class="w-full max-w-md rounded bg-slate-900 px-3 py-2 text-sm">
		<span class="flex items-center gap-2">
			<span class="h-2 w-2 rounded-full {colorFor(gameState.latestAccel.player)}"></span>
			Player {gameState.latestAccel.player} accel · x {gameState.latestAccel.x} · y {gameState
				.latestAccel.y} · z {gameState.latestAccel.z}
			<span class="ml-auto text-slate-500">{gameState.latestAccel.time}</span>
		</span>
	</div>
{/if}

<div class="w-full max-w-md">
	<h2 class="mb-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">Recent presses</h2>
	<ul class="flex flex-col gap-1">
		{#each gameState.events as e (e.id)}
			<li class="flex items-center justify-between rounded bg-slate-900 px-3 py-2 text-sm">
				<span class="flex items-center gap-2">
					<span class="h-2 w-2 rounded-full {colorFor(e.player)}"></span>
					Player {e.player} pressed <strong>{e.button}</strong> → {e.note}
				</span>
				<span class="text-slate-500">{e.time}</span>
			</li>
		{/each}
		{#if gameState.events.length === 0}
			<li class="text-sm text-slate-600">No presses yet.</li>
		{/if}
	</ul>
</div>
