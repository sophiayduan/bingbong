<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount, onDestroy } from 'svelte';
	import { gsap } from 'gsap';
	import { gameState, supported } from '$lib/game-state.svelte';

	let { children } = $props();

	const TITLE = 'bing bong';
	let titleEl: HTMLHeadingElement | undefined = $state();

	onMount(() => {
		if (!titleEl) return;
		const letters = titleEl.querySelectorAll('.letter');
		gsap.to(letters, {
			y: -14,
			duration: 0.8,
			ease: 'sine.inOut',
			repeat: -1,
			yoyo: true,
			stagger: {
				each: 0.08,
				repeat: -1,
				yoyo: true
			}
		});
	});

	onDestroy(() => {
		gameState.disconnect();
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<main class="relative flex min-h-screen flex-col items-center justify-center gap-8 p-8 bg-blue-300">
	<h1 bind:this={titleEl} class="text-8xl font-bold font-cloud text-gray-100/40">
		{#each TITLE as char, i (i)}
			<span class="letter inline-block">{char === ' ' ? ' ' : char}</span>
		{/each}
	</h1>

	{#if !supported}
		<p class="max-w-md text-center text-amber-400">
			Web Serial isn't available in this browser. Use Chrome or Edge on desktop, served over
			http://localhost or https://.
		</p>
	{:else}
		<div class="absolute w-fit h-fit top-8 left-8 flex items-center gap-3">
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
					class="rounded-lg bg-sky-500 px-5 py-2.5 font-medium text-white transition hover:bg-sky-400 disabled:opacity-50"
				>
					{gameState.status === 'connecting' ? 'Connecting...' : 'Connect via USB'}
				</button>
			{/if}

			<span class="text-sm">
				{#if gameState.status === 'connected'}
					Connected
				{:else if gameState.status === 'disconnected'}
					Disconnected — click Connect to retry
				{:else if gameState.status === 'error'}
					{gameState.errorMessage}
				{:else if gameState.status === 'connecting'}
					Waiting for device picker...
				{:else}
					Not connected
				{/if}
			</span>
		</div>

		{@render children()}
	{/if}
</main>
