<script lang="ts">
	import { gsap } from 'gsap';
	import { gameState, PLAYER_COLORS } from '$lib/game-state.svelte';
	import cat from '$lib/images/cat.webp';
	import catBing from '$lib/images/cat-bing.webp';
	import catWin1 from '$lib/images/cat-win1.webp';
	import catWin2 from '$lib/images/cat-win2.webp';
	import catLose1 from '$lib/images/cat-lose1.webp';
	import catLose2 from '$lib/images/cat-lose2.webp';
	import chick from '$lib/images/chick.webp';
	import chickBing from '$lib/images/chick-bing.webp';
	import chickWin1 from '$lib/images/chick-win1.webp';
	import chickWin2 from '$lib/images/chick-win2.webp';
	import chickLose1 from '$lib/images/chick-lose1.webp';
	import chickLose2 from '$lib/images/chick-lose2.webp';
	import goose from '$lib/images/goose.webp';
	import gooseBing from '$lib/images/goose-bing.webp';
	import gooseLose1 from '$lib/images/goose-lose1.webp';
	import gooseLose2 from '$lib/images/goose-lose2.webp';
	import ostridge from '$lib/images/ostridge.webp';
	import ostridgeBing from '$lib/images/ostridge-bing.webp';
	import ostridgeWin1 from '$lib/images/ostridge-win1.webp';
	import ostridgeWin2 from '$lib/images/ostridge-win2.webp';
	import ostridgeLose1 from '$lib/images/ostridge-lose1.webp';
	import ostridgeLose2 from '$lib/images/ostridge-lose2.webp';
	import fire1 from '$lib/images/fire-1.webp';
	import fire2 from '$lib/images/fire-2.webp';
	import PlayerLanes from '$lib/rhythm/PlayerLanes.svelte';
	import {
		rhythmGame,
		HIT_LINE_INSET_PX,
		hitBarHeightPx
	} from '$lib/rhythm/rhythm-state.svelte';
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
	// win/lose are each a 2-frame pair, alternated the same way as the fire
	// glow (see sprite-alt-a/b below). Ping/goose only has one drawn pair
	// (the lose frames), so win reuses it too.
	const SLOTS = [
		{ name: 'Bing', normal: cat, bing: catBing, win: [catWin1, catWin2], lose: [catLose1, catLose2] },
		{
			name: 'Bong',
			normal: chick,
			bing: chickBing,
			win: [chickWin1, chickWin2],
			lose: [chickLose1, chickLose2]
		},
		{
			name: 'Ping',
			normal: goose,
			bing: gooseBing,
			win: [gooseLose1, gooseLose2],
			lose: [gooseLose1, gooseLose2]
		},
		{
			name: 'Pong',
			normal: ostridge,
			bing: ostridgeBing,
			win: [ostridgeWin1, ostridgeWin2],
			lose: [ostridgeLose1, ostridgeLose2]
		}
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
	const barHeightPx = $derived(hitBarHeightPx(laneHeightPx));

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

	// A fire glow behind the character is always flickering (see the
	// fire-flicker-a/b animations below) once a streak hits 3 - it just
	// starts dim (FIRE_MIN_OPACITY) and ramps up to full brightness by 5,
	// staying there for 6+.
	const FIRE_MIN_OPACITY = 0.6;
	function fireGlowOpacity(combo: number) {
		if (combo < 3) return 0;
		if (combo >= 5) return 1;
		return FIRE_MIN_OPACITY + ((combo - 3) / 2) * (1 - FIRE_MIN_OPACITY);
	}

	// A combo this high swaps the character to its win sprite; this many
	// misses in a row (tracked separately from combo - see missStreaks)
	// swaps it to the lose sprite instead. Both are easy to retune.
	const WIN_COMBO_THRESHOLD = 15;
	const LOSE_STREAK_THRESHOLD = 4;
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
				class="pointer-events-none absolute inset-x-0"
				style="bottom: {HIT_LINE_INSET_PX}px; height: {barHeightPx}px; background: color-mix(in srgb, var(--color-dark-blue) 35%, transparent); border-top: 3px solid var(--color-dark-blue); border-bottom: 3px solid var(--color-dark-blue);"
			></div>

			{#each PLAYER_COLORS as _, i (i)}
				<div class="relative flex h-full w-50 shrink-0 lg:w-90">
					<PlayerLanes player={i + 1} {laneHeightPx} {barHeightPx} />
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
			{@const combo = gameState.hasStartedPlay ? (rhythmGame.combos.get(i + 1) ?? 0) : 0}
			{@const missStreak = gameState.hasStartedPlay ? (rhythmGame.missStreaks.get(i + 1) ?? 0) : 0}
			{@const isWinning = combo >= WIN_COMBO_THRESHOLD}
			{@const isLosing = !isWinning && missStreak >= LOSE_STREAK_THRESHOLD}
			{@const sprite = gameState.gooseMode
				? p?.flash
					? gooseBing
					: goose
				: p?.flash
					? slot.bing
					: slot.normal}
			{@const tint = gameState.gooseMode ? GOOSE_MODE_TINTS[i] : null}
			<div
				class="relative flex w-50 shrink-0 flex-col items-center lg:w-90 {gameState.hasStartedPlay
					? '-space-y-8 min-h-0'
					: 'group -space-y-2'}"
				style="z-index: {PLAYER_COLORS.length - i}"
				role="group"
				onmouseenter={gameState.hasStartedPlay ? undefined : () => startWave(i)}
				onmouseleave={gameState.hasStartedPlay ? undefined : () => stopWave(i)}
			>
				<div
					class="relative flex items-center justify-center {big
						? 'h-50 w-50 lg:h-90 lg:w-90'
						: 'h-50 w-50 lg:h-90 lg:w-90'}"
				>
					{#if fireGlowOpacity(combo) > 0}
						<!-- inset-0 + m-auto can't center a box bigger than its parent
						     (the centering math needs negative margins, which the spec
						     forbids - it pins to an edge instead) - translate-based
						     centering has no such size limit. -->
						<div
							class="pointer-events-none absolute top-[36%] left-1/2 h-[140%] w-[140%] -translate-x-1/2 -translate-y-1/2"
							style="opacity: {fireGlowOpacity(combo)}"
						>
							<img src={fire1} alt="" class="sprite-alt-a absolute inset-0 h-full w-full object-contain" />
							<img src={fire2} alt="" class="sprite-alt-b absolute inset-0 h-full w-full object-contain" />
						</div>
					{/if}
					<div
						class="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full transition-transform duration-150 {p?.flash
							? 'scale-110'
							: 'scale-100'} {p || isDevSelected ? '' : 'grayscale group-hover:grayscale-0  group-hover:scale-110 p-2 group-hover:-translate-y-6'}"
					>
						{#if isWinning}
							<img src={slot.win[0]} alt="" class="sprite-once-a absolute inset-0 h-full w-full object-cover" />
							<img src={slot.win[1]} alt="" class="sprite-once-b absolute inset-0 h-full w-full object-cover" />
						{:else if isLosing}
							<img src={slot.lose[0]} alt="" class="sprite-once-a absolute inset-0 h-full w-full object-cover" />
							<img src={slot.lose[1]} alt="" class="sprite-once-b absolute inset-0 h-full w-full object-cover" />
						{:else}
							<img src={sprite} alt="" class="h-full w-full object-cover group-hover:scale-116" />
							{#if tint}
								<div
									class="pointer-events-none absolute inset-0"
									style="background-color: {tint}; mix-blend-mode: overlay; mask-image: url({sprite}); mask-size: cover; mask-position: center; mask-repeat: no-repeat; -webkit-mask-image: url({sprite}); -webkit-mask-size: cover; -webkit-mask-position: center; -webkit-mask-repeat: no-repeat;"
								></div>
							{/if}
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
						<div class="flex items-baseline gap-1.5">
							<p
								bind:this={scoreEls[i]}
								class="text-center text-2xl xl:text-4xl font-cloud text-shadow-gray-800 text-shadow-xs"
								style="color: {scoreColor(score)}"
							>
								{score}
							</p>
							{#if combo >= COMBO_DISPLAY_MIN || comboBreakValue[i] !== null}
								<p
									bind:this={comboEls[i]}
									class="text-lg font-jua xl:text-2xl {comboBreakValue[i] !== null
										? 'text-red-400'
										: 'text-white/70'}"
								>
									x{comboBreakValue[i] ?? combo}
								</p>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	/* Generic hard-cut alternation (steps, not a crossfade) between two
	   stacked frames - used for the fire glow. The "b" variant is the same
	   animation offset by half a cycle, so exactly one frame is ever visible
	   at a time. */
	@keyframes sprite-alt {
		0%,
		49.9% {
			opacity: 1;
		}
		50%,
		100% {
			opacity: 0;
		}
	}

	/* Same hard-cut swap as sprite-alt, but for the win/lose sprite pairs -
	   these should only flap once and then hold on the second frame, not
	   loop forever, so each keyframe encodes its own end state instead of
	   relying on animation-delay + infinite. */
	@keyframes sprite-once-a {
		0%,
		49.9% {
			opacity: 1;
		}
		50%,
		100% {
			opacity: 0;
		}
	}

	@keyframes sprite-once-b {
		0%,
		49.9% {
			opacity: 0;
		}
		50%,
		100% {
			opacity: 1;
		}
	}

	.sprite-once-a {
		animation: sprite-once-a 900ms steps(1, end) forwards;
	}

	.sprite-once-b {
		animation: sprite-once-b 900ms steps(1, end) forwards;
	}

	.sprite-alt-a {
		animation: sprite-alt 900ms steps(1, end) infinite;
	}

	.sprite-alt-b {
		animation: sprite-alt 900ms steps(1, end) infinite;
		animation-delay: 450ms;
	}
</style>
