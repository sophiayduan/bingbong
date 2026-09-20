<script lang="ts">
	import { gsap } from 'gsap';
	import { gameState, CREATURES, PLAYER_COLORS } from '$lib/game-state.svelte';
	import cat from '$lib/images/cat.webp';
	import catBing from '$lib/images/cat-bing.webp';
	import chick from '$lib/images/chick.webp';
	import chickBing from '$lib/images/chick-bing.webp';
	import goose from '$lib/images/goose.webp';
	import gooseBing from '$lib/images/goose-bing.webp';
	import ostridge from '$lib/images/ostridge.webp';
	import ostridgeBing from '$lib/images/ostridge-bing.webp';

	const ANIMALS = [
		{ name: 'Bing', normal: cat, bing: catBing },
		{ name: 'Bong', normal: chick, bing: chickBing },
		{ name: 'Ping', normal: goose, bing: gooseBing },
		{ name: 'Pong', normal: ostridge, bing: ostridgeBing }
	];

	let { big = false }: { big?: boolean } = $props();

	let nameEls: (HTMLElement | undefined)[] = $state([]);
	let nameTweens: (gsap.core.Tween | undefined)[] = [];

	function startWave(i: number) {
		const el = nameEls[i];
		if (!el) return;
		const letters = el.querySelectorAll('.letter');
		nameTweens[i]?.kill();
		nameTweens[i] = gsap.to(letters, {
			y: -6,
			duration: 0.5,
			ease: 'sine.inOut',
			repeat: -1,
			yoyo: true,
			stagger: {
				each: 0.06,
				repeat: -1,
				yoyo: true
			}
		});
	}

	function stopWave(i: number) {
		nameTweens[i]?.kill();
		nameTweens[i] = undefined;
		const el = nameEls[i];
		if (!el) return;
		gsap.to(el.querySelectorAll('.letter'), { y: 0, duration: 0.2 });
	}
</script>

<svelte:head>
	{#each ANIMALS as animal (animal.name)}
		<link rel="preload" as="image" href={animal.bing} />
	{/each}
</svelte:head>

<div class="select-none mx-auto w-full h-auto flex items-start justify-center -space-x-4">
	{#each PLAYER_COLORS as _, i (i)}
		{@const p = gameState.playerStates.get(i + 1)}
		{@const creature = p ? gameState.creatureByMac.get(p.mac) : undefined}
		{@const animal = ANIMALS[i % ANIMALS.length]}
		<div
			class="relative flex w-50 shrink-0 flex-col items-center -space-y-2 group lg:w-90"
			style="z-index: {PLAYER_COLORS.length - i}"
			role="group"
			onmouseenter={() => startWave(i)}
			onmouseleave={() => stopWave(i)}
		>
			<div
				class=" flex items-center justify-center overflow-hidden rounded-full transition-transform duration-150 {big
					? 'h-50 w-50 lg:h-90 lg:w-90'
					: 'h-50 w-50 lg:h-90 lg:w-90'} {p?.flash ? 'scale-110' : 'scale-100'} {p ? '' : 'grayscale group-hover:grayscale-0  group-hover:scale-110 p-2 group-hover:-translate-y-6'}"
			>
				<img
					src={p?.flash ? animal.bing : animal.normal}
					alt=""
					class="h-full w-full object-cover  group-hover:scale-116"
				/>
			</div>
			<p
				bind:this={nameEls[i]}
				class="text-center text-lg xl:text-2xl group-hover:text-shadow-sm group-hover:xl:text-3xl hover:text-3xl font-cloud text-white/40 group-hover:text-white"
			>
				{#if p}
					Player {i + 1} · {creature !== undefined ? CREATURES[creature].name : '...'}
					{#if big}· button {p.button} · {p.time}{/if}
				{:else}
					{#each animal.name as char, ci (ci)}
						<span class="letter inline-block">{char}</span>
					{/each}
				{/if}
			</p>
		</div>
	{/each}
</div>
