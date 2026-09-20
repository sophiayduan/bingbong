<script lang="ts">
	import { gsap } from 'gsap';
	import { gameState, PLAYER_COLORS } from '$lib/game-state.svelte';
	import cat from '$lib/images/cat.webp';
	import catBing from '$lib/images/cat-bing.webp';
	import chick from '$lib/images/chick.webp';
	import chickBing from '$lib/images/chick-bing.webp';
	import goose from '$lib/images/goose.webp';
	import gooseBing from '$lib/images/goose-bing.webp';
	import ostridge from '$lib/images/ostridge.webp';
	import ostridgeBing from '$lib/images/ostridge-bing.webp';
	import PlayerLanes from '$lib/rhythm/PlayerLanes.svelte';
	import { rhythmGame, NOTE_TRAVEL_MS } from '$lib/rhythm/rhythm-state.svelte';
	import { PERFECT_WINDOW_MS } from '$lib/rhythm/judgment';
	import { devInput } from '$lib/dev-input.svelte';

	// Fixed per slot, forever - a slot's name, sprite and creature never
	// change no matter who connects or disconnects (see handleHello in
	// game-state.svelte.ts: creature is always player number - 1, i.e. this
	// same slot index). The sprite order below is NOT cosmetic - it has to
	// match CREATURES in game-state.svelte.ts (0 Cat, 1 Baby Chick,
	// 2 Canada Goose, 3 Turkey) exactly, since that's the same id the badge
	// uses to pick which name it draws on its own screen. There's no turkey
	// asset, so Turkey borrows the ostrich art. The `name` label is purely
	// decorative and doesn't need to match the sprite.
	const SLOTS = [
		{ name: 'Bing', normal: cat, bing: catBing },
		{ name: 'Bong', normal: chick, bing: chickBing },
		{ name: 'Ping', normal: goose, bing: gooseBing },
		{ name: 'Pong', normal: ostridge, bing: ostridgeBing }
	];

	// Goose mode: every slot shows the goose sprite instead of its own, tinted
	// with a solid-color silhouette (via mask-image on the same sprite, so the
	// color exactly matches the goose's outline) to tell the 4 players apart
	// now that they're all the same shape. null = no overlay - the actual
	// goose slot needs no recoloring since it's already correct as-is. Hex
	// values match --color-purple/--color-yellow/--color-pink in layout.css.
	const GOOSE_MODE_TINTS = ['#B791CF', '#E5C85D', null, '#E8BCB7'];

	let { big = false }: { big?: boolean } = $props();

	let nameEls: (HTMLElement | undefined)[] = $state([]);
	let nameTweens: (gsap.core.Tween | undefined)[] = [];

	let scoreEls: (HTMLElement | undefined)[] = $state([]);
	let prevScores = [0, 0, 0, 0];

	let comboEls: (HTMLElement | undefined)[] = $state([]);
	let prevCombos = [0, 0, 0, 0];
	// Frozen at the instant a streak breaks so the count can flash red and
	// hold for a beat instead of just silently snapping back to nothing.
	let comboBreakValue: (number | null)[] = $state([null, null, null, null]);
	let comboBreakTimeouts: (ReturnType<typeof setTimeout> | undefined)[] = [];

	// One hit bar shared by every player's lane, spanning the full row - see
	// PlayerLanes.svelte, which used to draw its own per-player. Measured
	// here once since all four lanes are always the same height.
	let laneHeightPx = $state(220);
	const pxPerMs = $derived(laneHeightPx / NOTE_TRAVEL_MS);
	const barHeightPx = $derived(Math.max(10, PERFECT_WINDOW_MS * 2 * pxPerMs));

	// White at 0, fully yellow by SCORE_COLOR_CAP - a running sense of
	// progress independent of the per-hit pop below.
	const SCORE_COLOR_CAP = 2000;
	const WHITE = [255, 255, 255];
	const YELLOW = [229, 200, 93]; // #E5C85D - keep in sync with --color-yellow in layout.css
	function scoreColor(score: number) {
		const t = Math.min(1, score / SCORE_COLOR_CAP);
		const [r, g, b] = WHITE.map((from, i) => Math.round(from + (YELLOW[i] - from) * t));
		return `rgb(${r}, ${g}, ${b})`;
	}

	$effect(() => {
		for (let i = 0; i < PLAYER_COLORS.length; i++) {
			const score = gameState.scores.get(i + 1) ?? 0;
			const el = scoreEls[i];
			if (score > prevScores[i] && el) {
				gsap.fromTo(el, { scale: 1.6 }, { scale: 1, duration: 0.4, ease: 'back.out(3)' });
			}
			prevScores[i] = score;
		}
	});

	// A combo of 1 isn't worth celebrating - the counter only shows once a
	// player's actually strung a couple hits together (COMBO_DISPLAY_MIN).
	const COMBO_DISPLAY_MIN = 2;
	$effect(() => {
		for (let i = 0; i < PLAYER_COLORS.length; i++) {
			const combo = rhythmGame.combos.get(i + 1) ?? 0;
			const el = comboEls[i];
			if (combo > prevCombos[i] && el) {
				gsap.fromTo(el, { scale: 1.6 }, { scale: 1, duration: 0.3, ease: 'back.out(3)' });
			} else if (combo === 0 && prevCombos[i] >= COMBO_DISPLAY_MIN) {
				comboBreakValue[i] = prevCombos[i];
				if (el) gsap.fromTo(el, { x: -6 }, { x: 0, duration: 0.4, ease: 'elastic.out(1, 0.3)' });
				clearTimeout(comboBreakTimeouts[i]);
				comboBreakTimeouts[i] = setTimeout(() => {
					comboBreakValue[i] = null;
				}, 500);
			}
			prevCombos[i] = combo;
		}
	});

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
	{#each SLOTS as slot (slot.name)}
		<link rel="preload" as="image" href={slot.bing} />
	{/each}
</svelte:head>

<div class="select-none mx-auto flex w-full flex-col important {gameState.hasStartedPlay ? 'h-full' : 'h-auto'}">
	{#if gameState.hasStartedPlay}
		<div
			class="relative flex w-full flex-1 min-h-0 justify-center -space-x-4"
			bind:clientHeight={laneHeightPx}
		>
			<!-- Drawn before the note columns below so it stays behind them in
			     the stacking order - a falling note should read as passing in
			     front of the bar, not sliding underneath it. -->
			<div
				class="pointer-events-none absolute inset-x-0 bottom-0"
				style="height: {barHeightPx}px; background: color-mix(in srgb, var(--color-dark-blue) 35%, transparent); border-top: 3px solid var(--color-dark-blue); border-bottom: 3px solid var(--color-dark-blue);"
			></div>

			{#each PLAYER_COLORS as _, i (i)}
				<div class="relative flex h-full w-50 shrink-0 lg:w-90">
					<PlayerLanes player={i + 1} {laneHeightPx} />
				</div>
			{/each}
		</div>
	{/if}

	<!-- Explicit positive z-index (position:static ignores z-index, hence
	     relative) so the characters escape above the ground layer in
	     +layout.svelte (z-10) - only the falling notes/banner above should
	     stay behind it. -->
	<div
		class="relative z-20 flex w-full justify-center -space-x-4 {gameState.hasStartedPlay
			? '-mt-8'
			: ''}"
	>
		{#each PLAYER_COLORS as _, i (i)}
			{@const p = gameState.playerStates.get(i + 1)}
			{@const slot = SLOTS[i]}
			{@const isDevSelected = import.meta.env.DEV && devInput.selectedPlayer === i + 1}
			{@const sprite = gameState.gooseMode
				? p?.flash
					? gooseBing
					: goose
				: p?.flash
					? slot.bing
					: slot.normal}
			{@const tint = gameState.gooseMode ? GOOSE_MODE_TINTS[i] : null}
			<div
				class="relative flex w-50 shrink-0 flex-col items-center group lg:w-90 {gameState.hasStartedPlay
					? '-space-y-8 min-h-0'
					: '-space-y-2'}"
				style="z-index: {PLAYER_COLORS.length - i}"
				role="group"
				onmouseenter={() => startWave(i)}
				onmouseleave={() => stopWave(i)}
			>
				<div
					class="relative flex items-center justify-center overflow-hidden rounded-full transition-transform duration-150 {big
						? 'h-50 w-50 lg:h-90 lg:w-90'
						: 'h-50 w-50 lg:h-90 lg:w-90'} {p?.flash ? 'scale-110' : 'scale-100'} {p || isDevSelected ? '' : 'grayscale group-hover:grayscale-0  group-hover:scale-110 p-2 group-hover:-translate-y-6'}"
				>
					<div class="relative h-full w-full group-hover:scale-116">
						<img src={sprite} alt="" class="h-full w-full object-cover" />
						{#if tint}
							<div
								class="pointer-events-none absolute inset-0"
								style="background-color: {tint}; mix-blend-mode: overlay; mask-image: url({sprite}); mask-size: cover; mask-position: center; mask-repeat: no-repeat; -webkit-mask-image: url({sprite}); -webkit-mask-size: cover; -webkit-mask-position: center; -webkit-mask-repeat: no-repeat;"
							></div>
						{/if}
					</div>
				</div>
				<div class="flex flex-col items-center">
					<p
						bind:this={nameEls[i]}
						class="text-center text-lg xl:text-2xl origin-center transition-transform duration-150 group-hover:scale-125 group-hover:text-shadow-sm font-cloud text-white/40 group-hover:text-white"
					>
						{#each slot.name as char, ci (ci)}
							<span class="letter inline-block">{char}</span>
						{/each}
					</p>
					{#if gameState.hasStartedPlay}
						{@const score = gameState.scores.get(i + 1) ?? 0}
						<p
							bind:this={scoreEls[i]}
							class="text-center text-2xl xl:text-4xl font-cloud text-shadow-gray-800 text-shadow-xs"
							style="color: {scoreColor(score)}"
						>
							{score}
						</p>
						<!-- Combo counter, disabled for now - see the $effect above
						     that still drives comboEls/comboBreakValue.
						{@const combo = rhythmGame.combos.get(i + 1) ?? 0}
						{#if combo >= COMBO_DISPLAY_MIN || comboBreakValue[i] !== null}
							<p
								bind:this={comboEls[i]}
								class="text-center text-sm font-jua xl:text-lg {comboBreakValue[i] !== null
									? 'text-red-400'
									: 'text-white/70'}"
							>
								{comboBreakValue[i] ?? combo}x combo
							</p>
						{/if}
						-->
					{/if}
				</div>
			</div>
		{/each}
	</div>
</div>
