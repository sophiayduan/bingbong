<script lang="ts">
	import { tick } from 'svelte';
	import { gsap } from 'gsap';
	import { gameState, colorFor } from '$lib/game-state.svelte';
	import { devInput } from '$lib/dev-input.svelte';
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
		disabled={gameState.playerStates.size === 0 && !devInput.enabled}
		class="fixed bottom-6 right-6 z-[110] flex h-14 w-14 items-center justify-center rounded-lg bg-dark-blue font-jua font-semibold text-white shadow-xl transition hover:bg-light-blue disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-dark-blue"
	>
		<!-- Same arrow used for the rhythm lanes' up/down/left/right notes
		     (see PlayerLanes.svelte) and the end-of-level "Next" button (see
		     ResultsScreen.svelte) - it points up with no rotation, so 90deg
		     clockwise is what "next" points right. -->
		<svg viewBox="0 0 25 26" class="h-8 w-8" style="transform: rotate(90deg);" xmlns="http://www.w3.org/2000/svg">
			<path
				d="M23.7858 10.8206C24.6139 11.6512 24.5528 13.0129 23.6536 13.766L23.5189 13.8788C22.7289 14.5404 21.5655 14.4935 20.8313 13.7705L16.3243 9.33165C15.604 8.6223 14.3907 9.19896 14.4859 10.2054L14.3632 23.6433C14.3532 24.7407 13.4607 25.625 12.3633 25.625H11.7635C10.6518 25.625 9.75339 24.7184 9.76354 23.6067L9.8859 10.2054C9.9811 9.19896 8.7678 8.6223 8.04753 9.33166L3.54045 13.7705C2.80628 14.4935 1.64292 14.5404 0.852935 13.8788L0.715675 13.7638C-0.1826 13.0115 -0.244685 11.6516 0.581303 10.8206L10.7496 0.590372C11.5307 -0.195573 12.802 -0.19654 13.5844 0.588215L23.7858 10.8206Z"
				fill="white"
			/>
		</svg>
	</button>

	{#if import.meta.env.DEV}
		<button
			onclick={() => (devInput.enabled = !devInput.enabled)}
			class="fixed bottom-6 left-6 z-[110] rounded-lg bg-slate-700/70 px-3 py-1.5 text-sm font-jua text-white/70 opacity-0 shadow transition hover:opacity-100"
		>
			Dev tools: {devInput.enabled ? 'on' : 'off'}
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
