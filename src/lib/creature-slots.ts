import cat from '$lib/images/cat.webp';
import catBing from '$lib/images/cat-bing.webp';
import catEmote from '$lib/images/cat-emote.webp';
import catWin1 from '$lib/images/cat-win1.webp';
import catWin2 from '$lib/images/cat-win2.webp';
import catLose1 from '$lib/images/cat-lose1.webp';
import catLose2 from '$lib/images/cat-lose2.webp';
import chick from '$lib/images/chick.webp';
import chickBing from '$lib/images/chick-bing.webp';
import chickEmote from '$lib/images/chick-emote.webp';
import chickWin1 from '$lib/images/chick-win1.webp';
import chickWin2 from '$lib/images/chick-win2.webp';
import chickLose1 from '$lib/images/chick-lose1.webp';
import chickLose2 from '$lib/images/chick-lose2.webp';
import goose from '$lib/images/goose.webp';
import gooseBing from '$lib/images/goose-bing.webp';
import gooseEmote from '$lib/images/goose-emote.webp';
import gooseLose1 from '$lib/images/goose-lose1.webp';
import gooseLose2 from '$lib/images/goose-lose2.webp';
import ostridge from '$lib/images/ostridge.webp';
import ostridgeBing from '$lib/images/ostridge-bing.webp';
import ostridgeEmote from '$lib/images/ostridge-emote.webp';
import ostridgeWin1 from '$lib/images/ostridge-win1.webp';
import ostridgeWin2 from '$lib/images/ostridge-win2.webp';
import ostridgeLose1 from '$lib/images/ostridge-lose1.webp';
import ostridgeLose2 from '$lib/images/ostridge-lose2.webp';

// Fixed per slot, forever - a slot's name, sprite and creature never change
// no matter who connects or disconnects (see handleHello in
// game-state.svelte.ts: creature is always player number - 1, i.e. this
// same slot index). The sprite order below is NOT cosmetic - it has to
// match CREATURES in game-state.svelte.ts (0 Cat, 1 Baby Chick, 2 Canada
// Goose, 3 Turkey) exactly, since that's the same id the badge uses to pick
// which name it draws on its own screen. There's no turkey asset, so Turkey
// borrows the ostrich art. The `name` label is purely decorative and
// doesn't need to match the sprite.
// win/lose are each a 2-frame pair, alternated the same way as the fire
// glow (see sprite-alt-a/b in PlayerCircles.svelte). Ping/goose only has
// one drawn pair (the lose frames), so win reuses it too.
// emote is the results-screen counterpart of bing - the same "this badge
// was just pressed" swap, but held much longer (see RESULTS_EMOTE_FLASH_MS
// in game-state.svelte.ts) since it's reacting to a press over the frozen
// win/lose pose rather than a mid-round tap.
// Shared by PlayerCircles.svelte (in-round sprite) and ResultsScreen.svelte
// (end-of-level win/lose emote), so the two never drift out of sync.
export const SLOTS = [
	{
		name: 'Bing',
		normal: cat,
		bing: catBing,
		emote: catEmote,
		win: [catWin1, catWin2],
		lose: [catLose1, catLose2]
	},
	{
		name: 'Bong',
		normal: chick,
		bing: chickBing,
		emote: chickEmote,
		win: [chickWin1, chickWin2],
		lose: [chickLose1, chickLose2]
	},
	{
		name: 'Ping',
		normal: goose,
		bing: gooseBing,
		emote: gooseEmote,
		win: [gooseLose1, gooseLose2],
		lose: [gooseLose1, gooseLose2]
	},
	{
		name: 'Pong',
		normal: ostridge,
		bing: ostridgeBing,
		emote: ostridgeEmote,
		win: [ostridgeWin1, ostridgeWin2],
		lose: [ostridgeLose1, ostridgeLose2]
	}
];
