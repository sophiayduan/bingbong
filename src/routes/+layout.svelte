<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import background from '$lib/images/background.webp';
	import intenseTl from '$lib/images/intense-tl.webp';
	import intenseTr from '$lib/images/intense-tr.webp';
	import intenseBl from '$lib/images/intense-bl.webp';
	import intenseBr from '$lib/images/intense-br.webp';
	import { onMount, onDestroy } from 'svelte';
	import { gsap } from 'gsap';
	import { gameState, supported } from '$lib/game-state.svelte';

	let { children } = $props();

	const TITLE = 'bing bong';
	let titleEl: HTMLHeadingElement | undefined = $state();

	const SUBTITLE_LINE_1 = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit';
	const SUBTITLE_LINE_2 = 'amet, consectetur adipiscing elit.';
	let subtitleEl: HTMLParagraphElement | undefined = $state();

	let titleTween: gsap.core.Tween | undefined;

	$effect(() => {
		if (!titleEl) return;
		const letters = titleEl.querySelectorAll('.letter');
		titleTween?.kill();
		titleTween = gsap.to(letters, {
			y: gameState.hasStartedPlay ? -4 : -14,
			duration: gameState.hasStartedPlay ? 1.6 : 0.8,
			ease: 'sine.inOut',
			repeat: -1,
			yoyo: true,
			stagger: {
				each: gameState.hasStartedPlay ? 0.12 : 0.08,
				repeat: -1,
				yoyo: true
			}
		});
	});

	onMount(() => {
		if (!subtitleEl) return;
		const subtitleLetters = subtitleEl.querySelectorAll('.letter');
		gsap.to(subtitleLetters, {
			y: -4,
			duration: 1,
			ease: 'sine.inOut',
			repeat: -1,
			yoyo: true,
			stagger: {
				each: 0.03,
				repeat: -1,
				yoyo: true
			}
		});
	});

	onDestroy(() => {
		gameState.disconnect();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
	<link href="https://fonts.googleapis.com/css2?family=Jua&display=swap" rel="stylesheet" />
</svelte:head>

<div
	class="absolute inset-0 -z-10 bg-light-blue bg-cover bg-center bg-no-repeat transition-transform duration-[1200ms] ease-in-out {gameState.hasStartedPlay
		? 'translate-y-40'
		: ''}"
	style="background-image: url({background});"
></div>
<!-- INTENSE MODE -->
<!-- <div
	class="pointer-events-none fixed inset-0 z-50 "
	style="background: radial-gradient(ellipse at center, transparent 70%, rgba(255, 0, 0, 0.6) 100%);"
></div>
<div class="pointer-events-none fixed inset-0 z-48 bg-black/40"></div>

<div class="pointer-events-none fixed inset-0 z-[60]">
	<img src={intenseTl} alt="" class="absolute top-0 left-0 h-auto w-1/3" />
	<img src={intenseTr} alt="" class="absolute top-0 right-0 h-auto w-1/3" />
	<img src={intenseBl} alt="" class="absolute bottom-0 left-0 h-auto w-1/3" />
	<img src={intenseBr} alt="" class="absolute right-0 bottom-0 h-auto w-1/3" />
</div> -->

<main class="relative flex h-screen overflow-hidden flex-col items-center justify-center gap-8 p-8">
	<h1
		bind:this={titleEl}
		class="absolute left-1/2 -translate-x-1/2 whitespace-nowrap font-bold font-cloud text-white text-shadow-gray-400 text-shadow-xs transition-all duration-[1200ms] ease-in-out {gameState.hasStartedPlay
			? 'top-4 text-md'
			: 'top-24 text-6xl sm:text-8xl lg:top-32 lg:text-9xl'}"
	>
		{#each TITLE as char, i (i)}
			<span class="letter inline-block">{char === ' ' ? ' ' : char}</span>
		{/each}
	</h1>

	<p
		bind:this={subtitleEl}
		class="absolute left-1/2 -translate-x-1/2 whitespace-nowrap font-jua text-xl text-white/80 text-center {gameState.hasStartedPlay
			? 'hidden'
			: 'top-44 sm:top-64 lg:top-74'}"
	>
		{#each SUBTITLE_LINE_1 as char, i (i)}
			<span class="letter inline-block">{char === ' ' ? ' ' : char}</span>
		{/each}
		<br />
		{#each SUBTITLE_LINE_2 as char, i (i)}
			<span class="letter inline-block">{char === ' ' ? ' ' : char}</span>
		{/each}
	</p>

	{#if !supported}
		<p class="max-w-md text-center text-amber-400">
			Web Serial isn't available in this browser. Use Chrome or Edge on desktop, served over
			http://localhost or https://.
		</p>
	{:else}
		<div class="group absolute top-8 left-8 flex h-fit w-fit items-center">
			{#if gameState.status !== 'connected'}
				<svg
					viewBox="0 0 24 24"
					class="pointer-events-none absolute h-10 w-10 transition-opacity duration-300 group-hover:opacity-0"
				>
					<circle cx="12" cy="12" r="6.5" fill="none" stroke="#4d6b76" stroke-width="5" />
				</svg>
			{/if}

			<div
				class="flex items-center gap-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
			>
				{#if gameState.status === 'connected'}
					<button
						onclick={() => gameState.disconnect()}
						class="rounded-sm px-5 py-2.5 font-medium text-white transition"
					>
						Disconnect
					</button>
				{:else}
					<button
						onclick={() => gameState.connect()}
						disabled={gameState.status === 'connecting'}
						class="rounded-lg bg-sky-500 px-5 py-2.5 font-semibold text-white transition hover:bg-sky-400 disabled:opacity-50"
					>
						{gameState.status === 'connecting' ? 'Connecting...' : 'Connect'}
					</button>
				{/if}

				<span class="text-sm opacity-60">
					{#if gameState.status === 'connected'}
						Connected
					{:else if gameState.status === 'disconnected'}
						Disconnected
					{:else if gameState.status === 'error'}
						{gameState.errorMessage}
					{:else if gameState.status === 'connecting'}
						Waiting for device picker...
					{:else}
						Not connected
					{/if}
				</span>
			</div>
		</div>

		<div
			class="pointer-events-none absolute top-8 right-8 flex items-center gap-2 transition-opacity duration-500 {gameState.volumeVisible
				? 'opacity-100'
				: 'opacity-0'}"
		>
			<svg
				class="h-6 w-6 flex-shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="white"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M4 9v6h4l5 5V4L8 9H4z" fill="white" stroke="none" />
				<path d="M15 8.5a5 5 0 0 1 0 7" />
				<path d="M17.5 6a8.5 8.5 0 0 1 0 12" />
			</svg>
			<span class="font-jua text-xl text-white">{gameState.volumePercent}%</span>
		</div>

		{#if gameState.gooseMode}
			<span class="pointer-events-none absolute bottom-8 left-8 font-jua text-xl text-white">
				GOOSE MODE ON
			</span>
		{/if}

		{@render children()}
	{/if}
</main>
