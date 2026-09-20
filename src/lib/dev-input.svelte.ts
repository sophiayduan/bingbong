// Shared with PlayerCircles.svelte so the character DevKeyboardInput is
// currently controlling can be shown as active (not greyed out) even
// before it's thrown a real press.
class DevInput {
	selectedPlayer = $state(1);
}

export const devInput = new DevInput();
