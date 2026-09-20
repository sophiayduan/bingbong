<script lang="ts">
	import { onMount } from 'svelte';
	import { gsap } from 'gsap';
	import { fade } from 'svelte/transition';
	import { gameState, PLAYER_COLORS } from '$lib/game-state.svelte';
	import { SLOTS } from '$lib/creature-slots';
	import goose from '$lib/images/goose.webp';
	import gooseBing from '$lib/images/goose-bing.webp';
	import fire1 from '$lib/images/fire-1.webp';
	import fire2 from '$lib/images/fire-2.webp';
	import PlayerLanes from '$lib/rhythm/PlayerLanes.svelte';
	import {
		rhythmGame,
		HIT_LINE_INSET_PX,
		hitBarHeightPx
	} from '$lib/rhythm/rhythm-state.svelte';
	import { devInput } from '$lib/dev-input.svelte';

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
	const LOSE_STREAK_THRESHOLD = 6;

	// Highest final score once the match is over - used to decide who gets
	// the win treatment on the results view (see isWinning below). 0 outside
	// of matchOver since nobody's reading it then.
	const finalTopScore = $derived(
		gameState.matchOver
			? Math.max(0, ...PLAYER_COLORS.map((_, i) => gameState.scores.get(i + 1) ?? 0))
			: 0
	);

	// Everything but the winner reads as one dark vignette (see the overlay
	// markup below) with a hole punched over their circle - measured in real
	// px off the DOM rather than derived from flex-layout math, so it lines
	// up exactly regardless of viewport size or how the row happens to be
	// spaced. Only the first winner is spotlit on a tie (rare with the
	// placeholder charts, and every winner still gets the big/looping
	// treatment either way - just not literally lit).
	let circleEls: (HTMLElement | undefined)[] = $state([]);
	let spotlight = $state<{
		x: number;
		topHalf: number;
		poolCy: number;
		poolRx: number;
		poolRy: number;
	} | null>(null);

	// Bottom of the light pool never gets closer than this to the actual
	// bottom of the viewport, however big the winner's (scaled-up) circle
	// ends up being - this is what keeps the beam ending "before the bottom
	// of the page" instead of running the oval off the edge.
	const POOL_BOTTOM_MARGIN_PX = 40;

	function measureSpotlight() {
		if (!gameState.matchOver || finalTopScore <= 0) {
			spotlight = null;
			return;
		}
		const winnerIndex = PLAYER_COLORS.findIndex(
			(_, i) => (gameState.scores.get(i + 1) ?? 0) === finalTopScore
		);
		const el = circleEls[winnerIndex];
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const r = Math.max(rect.width, rect.height) / 2;
		const poolRx = r * 1.1;
		const poolRy = poolRx * 0.32;
		spotlight = {
			x: cx,
			topHalf: r * 0.45,
			poolRx,
			poolRy,
			poolCy: Math.min(cy + r * 0.25, window.innerHeight - poolRy - POOL_BOTTOM_MARGIN_PX)
		};
	}

	$effect(() => {
		// Re-measure whenever the match-over/score state changes, and once
		// more shortly after - the winner's circle is still mid-grow (see
		// circleScale's transition, 300ms) at the instant matchOver flips, so
		// an immediate measurement would size the hole to its pre-grow rect.
		void gameState.matchOver;
		void finalTopScore;
		measureSpotlight();
		if (!gameState.matchOver) return;
		const t = setTimeout(measureSpotlight, 350);
		return () => clearTimeout(t);
	});

	onMount(() => {
		window.addEventListener('resize', measureSpotlight);
		return () => window.removeEventListener('resize', measureSpotlight);
	});
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

<div class="select-none mx-auto flex w-full flex-col items-center important {gameState.hasStartedPlay ? 'h-full' : 'h-auto'}">
	{#if gameState.hasStartedPlay}
		<div
			class="relative flex w-full flex-1 min-h-0 justify-center"
			bind:clientHeight={laneHeightPx}
		>
			<!-- Drawn before the note columns below so it stays behind them in
			     the stacking order - a falling note should read as passing in
			     front of the bar, not sliding underneath it. -inset-x-14 +
			     the mask-image gradient let the bar bleed a bit past the lanes
			     and fade out at its own edges rather than ending in a hard cut.
			     Once the match is over there's nothing left to hit, so it
			     fades/slides up out of the way instead of just sitting there
			     behind the win/lose sprites - and slides back in on its own
			     when the next level's countdown flips matchOver back off. -->
			<div
				class="pointer-events-none absolute -inset-x-14 transition-all duration-500 ease-in-out {gameState.matchOver
					? '-translate-y-6 opacity-0'
					: 'translate-y-0 opacity-100'}"
				style="bottom: {HIT_LINE_INSET_PX}px; height: {barHeightPx}px; background: color-mix(in srgb, var(--color-dark-blue) 35%, transparent); border-top: 3px solid var(--color-dark-blue); border-bottom: 3px solid var(--color-dark-blue); mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent); -webkit-mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent);"
			></div>

			<!-- Own flex wrapper so -space-x-4 only ever sees the 4 lane divs
			     as siblings - the hit bar above is a DOM sibling too (even
			     though it's position:absolute and takes no layout space), and
			     Tailwind's space-x selector (> * + *) counts DOM order, not
			     layout participation. Left in the same flow as the hit bar,
			     player 1's lane was picking up a -space-x-4 margin the
			     character row below never applies to player 1, pushing every
			     lane out of alignment with its own character. -->
			<div class="relative flex h-full justify-center -space-x-4">
				{#each PLAYER_COLORS as _, i (i)}
					<div class="relative flex h-full w-50 shrink-0 justify-center lg:w-90">
						<PlayerLanes player={i + 1} {laneHeightPx} {barHeightPx} />
					</div>
				{/each}
			</div>
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
			{@const score = gameState.scores.get(i + 1) ?? 0}
			<!-- Once the match is over, win/lose reads off the final score
			     instead of the live combo/miss-streak - the same sprite swap
			     the round already used, now judging the round instead of the
			     moment. Ties all get the win treatment together. -->
			{@const isWinning = gameState.matchOver
				? finalTopScore > 0 && score === finalTopScore
				: combo >= WIN_COMBO_THRESHOLD}
			{@const isLosing = gameState.matchOver
				? !isWinning
				: !isWinning && missStreak >= LOSE_STREAK_THRESHOLD}
			{@const circleScale = gameState.matchOver
				? isWinning
					? 'scale-150'
					: 'scale-90'
				: p?.flash
					? 'scale-110'
					: 'scale-100'}
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
						bind:this={circleEls[i]}
						class="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full transition-transform duration-300 {circleScale} {p ||
						isDevSelected
							? ''
							: 'grayscale group-hover:grayscale-0  group-hover:scale-110 p-2 group-hover:-translate-y-6'}"
					>
						{#if isWinning}
							<!-- Loops (sprite-alt-a/b) rather than flapping once and
							     holding - a winner keeps celebrating for as long as
							     it's shown, unlike the one-shot lose pose below. -->
							<img src={slot.win[0]} alt="" class="sprite-alt-a absolute inset-0 h-full w-full object-cover" />
							<img src={slot.win[1]} alt="" class="sprite-alt-b absolute inset-0 h-full w-full object-cover" />
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

{#if spotlight}
	<!-- A hard-edged yellow beam straight down from the top of the screen,
	     ending in a flattened oval pool of light rather than running to the
	     bottom of the page or cutting off in a flat line - the classic
	     cartoon-spotlight shape. Traced as one outline (trapezoid sides
	     into a half-ellipse arc for the pool) so it can be reused as a
	     single clip-path for the yellow beam fill and, prefixed with a
	     giant rectangle under an evenodd rule, as the hole punched in the
	     dark scrim over everything else - no soft gradient anywhere, so
	     every edge stays sharp. Both clear the ground layer (z-10 in
	     +layout.svelte) and this component's own character row (z-20).
	     The clip-path transition (on top of the fade-in/out) is what makes
	     the beam widen/settle into place smoothly instead of snapping when
	     measureSpotlight's re-measure (after the winner's grow animation
	     finishes) updates these numbers mid-reveal. -->
	{@const beamShape = `M ${spotlight.x - spotlight.topHalf} 0 L ${spotlight.x + spotlight.topHalf} 0 L ${spotlight.x + spotlight.poolRx} ${spotlight.poolCy} A ${spotlight.poolRx} ${spotlight.poolRy} 0 0 1 ${spotlight.x - spotlight.poolRx} ${spotlight.poolCy} Z`}

	<div
		transition:fade={{ duration: 500 }}
		class="pointer-events-none fixed inset-0 z-[24] transition-[clip-path] duration-500 ease-out"
		style="background: rgba(255, 214, 102, 0.4); clip-path: path('{beamShape}');"
	></div>
	<div
		transition:fade={{ duration: 500 }}
		class="pointer-events-none fixed inset-0 z-[25] transition-[clip-path] duration-500 ease-out"
		style="background: rgba(10, 12, 20, 0.5); clip-path: path(evenodd, 'M -4000 -4000 H 4000 V 4000 H -4000 Z {beamShape}');"
	></div>
{/if}

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
