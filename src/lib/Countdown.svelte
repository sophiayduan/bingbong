<script lang="ts">
	import { onDestroy } from 'svelte';
	import { gsap } from 'gsap';
	import { gameState } from '$lib/game-state.svelte';
	import { rhythmGame } from '$lib/rhythm/rhythm-state.svelte';
	import { CHARTS_BY_LEVEL, DEFAULT_LEVEL_ID } from '$lib/rhythm/levels';

	// Always mounted (never behind an {#if}) so these refs are bound before
	// countingDown ever flips true - no race waiting for a conditional block
	// to render before the timeline can start.
	let dimEl: HTMLDivElement | undefined = $state();
	let numberEl: HTMLDivElement | undefined = $state();
	let flashEl: HTMLDivElement | undefined = $state();
	let display = $state('');
	let timeline: gsap.core.Timeline | undefined;

	$effect(() => {
		if (gameState.countingDown) runSequence();
	});

	function runSequence() {
		if (!dimEl || !numberEl || !flashEl) return;
		timeline?.kill();

		timeline = gsap.timeline({ onComplete: () => gameState.endCountdown() });
		timeline.set(numberEl, { opacity: 0, scale: 0.4 });
		timeline.set(flashEl, { opacity: 0 });
		timeline.to(dimEl, { opacity: 0.75, duration: 0.25 });

		for (const n of ['3', '2', '1']) {
			timeline.call(() => {
				display = n;
				gameState.playCountdownTick();
			});
			timeline.fromTo(
				numberEl,
				{ scale: 0.4, opacity: 0 },
				{ scale: 1, opacity: 1, duration: 0.25, ease: 'back.out(3)' }
			);
			timeline.to(numberEl, { scale: 1.1, opacity: 0, duration: 0.35, ease: 'power1.in' }, '+=0.25');
		}

		timeline.call(() => {
			display = 'GO!';
			gameState.playGoSound();
			gameState.startBeatLoop();
			gameState.startMatchTimer();
			// TODO: swap the default level for a real level-select once one exists.
			rhythmGame.start(CHARTS_BY_LEVEL[DEFAULT_LEVEL_ID]);
		});
		timeline.fromTo(
			numberEl,
			{ scale: 0.6, opacity: 0 },
			{ scale: 1.3, opacity: 1, duration: 0.3, ease: 'back.out(4)' }
		);
		timeline.fromTo(flashEl, { opacity: 0.9 }, { opacity: 0, duration: 0.4 }, '<');
		timeline.to(numberEl, { opacity: 0, duration: 0.2 }, '+=0.3');
		timeline.to(dimEl, { opacity: 0, duration: 0.3 }, '-=0.1');
	}

	onDestroy(() => timeline?.kill());
</script>

<div class="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center overflow-hidden">
	<div bind:this={dimEl} class="absolute inset-0 bg-black opacity-0"></div>
	<div
		bind:this={numberEl}
		class="relative font-cloud text-white text-shadow-gray-800 text-shadow-lg text-[10rem] opacity-0 sm:text-[14rem]"
	>
		{display}
	</div>
	<div bind:this={flashEl} class="absolute inset-0 bg-white opacity-0"></div>
</div>
