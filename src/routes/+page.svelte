<script lang="ts">
	import { tick } from 'svelte';
	import { gsap } from 'gsap';
	import { gameState, colorFor } from '$lib/game-state.svelte';
	import PlayerCircles from '$lib/PlayerCircles.svelte';

	let circlesEl: HTMLDivElement | undefined = $state();

	async function handleNext() {
		const startRect = circlesEl?.getBoundingClientRect();
		gameState.goToPlay();
		await tick();
		if (!circlesEl || !startRect) {
			gameState.startCountdown();
			return;
		}
		const endRect = circlesEl.getBoundingClientRect();
		const deltaY = startRect.top - endRect.top;
		// Animated via `top`, not GSAP's `y` (which uses a CSS transform) -
		// a transform on this element would create a stacking context that
		// traps everything inside it (both the note lanes and the character
		// row) together, breaking the z-index split that lets characters
		// sit above the ground layer while notes stay behind it.
		gsap.fromTo(
			circlesEl,
			{ top: deltaY },
			{
				top: 0,
				duration: 1.2,
				ease: 'power2.inOut',
				onComplete: () => gameState.startCountdown()
			}
		);
	}

	// D7 on the XIAO sends its own NEXT line (see xiao_espnow_gateway.ino) to
	// trigger this same button, without being able to fire more than once.
	let lastHandledNext = 0;
	$effect(() => {
		if (gameState.nextRequested > lastHandledNext) {
			lastHandledNext = gameState.nextRequested;
			if (!gameState.hasStartedPlay) handleNext();
		}
	});
</script>
<div
	bind:this={circlesEl}
	class="relative {gameState.hasStartedPlay ? 'h-full' : 'mt-30 lg:mt-60'}"
>
<PlayerCircles big={true} />

</div>

{#if !gameState.hasStartedPlay}
	<button
		onclick={handleNext}
		disabled={gameState.playerStates.size === 0}
		class="fixed bottom-6 right-6 z-[110] rounded-lg bg-dark-blue px-5 py-2 text-2xl font-jua font-semibold text-white shadow-xl transition hover:bg-blue-700/80 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-dark-blue"
	>
		Next
	</button>

	{#if import.meta.env.DEV}
		<button
			onclick={handleNext}
			class="fixed bottom-6 left-6 z-[110] rounded-lg bg-slate-700/70 px-3 py-1.5 text-sm font-jua text-white/70 shadow transition hover:bg-slate-600"
		>
			Dev: skip to game
		</button>
	{/if}
{/if}

{#if gameState.latestAccel}
	<div class="w-full max-w-md rounded px-3 py-2">
		<span class="flex items-center gap-2">
			<span class="h-2 w-2 rounded-full {colorFor(gameState.latestAccel.player)}"></span>
			Player {gameState.latestAccel.player} accel · x {gameState.latestAccel.x} · y {gameState
				.latestAccel.y} · z {gameState.latestAccel.z}
			<span class="ml-auto text-slate-500">{gameState.latestAccel.time}</span>
		</span>
	</div>
{/if}

<!-- <div class="w-full max-w-md">
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
</div> -->
