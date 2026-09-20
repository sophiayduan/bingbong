// Shared with PlayerCircles.svelte so the character DevKeyboardInput is
// currently controlling can be shown as active (not greyed out) even
// before it's thrown a real press.
class DevInput {
	selectedPlayer = $state(1);

	// Gates keyboard-simulated presses and starting a game with no players
	// joined - armed by the hidden dev-tools button on the start cover
	// (+page.svelte) rather than being on by default in every dev build.
	enabled = $state(false);
}

export const devInput = new DevInput();
