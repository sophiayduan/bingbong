import { goto } from '$app/navigation';

// Espressif's USB vendor ID - the XIAO's native USB-JTAG/serial port
// enumerates under this, so the picker only shows relevant devices.
const USB_VENDOR_ID = 0x303a;

export const PLAYER_COLORS = ['bg-rose-500', 'bg-sky-500', 'bg-emerald-500', 'bg-amber-500'];

// C major scale, one octave. Button letters map onto this in order
// (A -> C4, B -> D4, ...) and wrap around for badges with more buttons.
const C_MAJOR_SCALE: { note: string; freq: number }[] = [
	{ note: 'C4', freq: 261.63 },
	{ note: 'D4', freq: 293.66 },
	{ note: 'E4', freq: 329.63 },
	{ note: 'F4', freq: 349.23 },
	{ note: 'G4', freq: 392.0 },
	{ note: 'A4', freq: 440.0 },
	{ note: 'B4', freq: 493.88 },
	{ note: 'C5', freq: 523.25 }
];

function noteForButton(button: string) {
	const letter = button.trim().toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
	const index = ((letter % C_MAJOR_SCALE.length) + C_MAJOR_SCALE.length) % C_MAJOR_SCALE.length;
	return C_MAJOR_SCALE[index];
}

// Wire representation is the array index (0-3), sent as a single byte over
// ESP-NOW/serial - see ESPNOW_MAGIC_ASSIGN in badge_espnow_firmware/main/main.c
// and creature_banners.h, which must list creatures in this same order (and
// SLOTS in PlayerCircles.svelte, whose sprite order must also match this).
// Each creature shifts every button's scale note by this multiplier (its
// "call" register) - the button still picks which scale degree plays.
export const CREATURES = [
	{ name: 'Cat', pitchMultiplier: 1 },
	{ name: 'Baby Chick', pitchMultiplier: 2 }, // up an octave: high peep
	{ name: 'Canada Goose', pitchMultiplier: 0.5 }, // down an octave: low honk
	{ name: 'Turkey', pitchMultiplier: 0.75 } // down a fourth: gobble register
];

export type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export type ButtonPress = {
	id: number;
	mac: string;
	button: string;
	note: string;
	player: number;
	// undefined only if this press beat the handshake reply back from its badge.
	creature: number | undefined;
	time: string;
};

export type AccelSample = {
	mac: string;
	player: number;
	x: number;
	y: number;
	z: number;
	time: string;
};

// One slot per player, updated and flashed independently so that two
// badges pressed at the same instant each get their own visible state
// instead of the second press silently clobbering the first.
export type PlayerState = ButtonPress & { flash: boolean };

export const supported = typeof navigator !== 'undefined' && !!navigator.serial;

export function colorFor(player: number) {
	return PLAYER_COLORS[(player - 1) % PLAYER_COLORS.length];
}

class GameState {
	status = $state<Status>('idle');
	errorMessage = $state('');
	events = $state<ButtonPress[]>([]);
	playerStates = $state<Map<number, PlayerState>>(new Map());
	latestAccel = $state<AccelSample | null>(null);
	// mac -> creature id (0-3), always player number - 1 (see handleHello).
	// Separate from playerStates because a badge gets this the instant it
	// HELLOs, before anyone's pressed a button.
	creatureByMac = $state<Map<string, number>>(new Map());

	hasStartedPlay = $state(false);
	// Controlled by the local D1/D10 switches (see VOL lines below). 1 = the
	// original fixed 0.3 peak gain; displayed to 0-100 via volumePercent.
	volume = $state(1);
	// True while the on-screen volume readout should be visible - shown on
	// every VOL line and faded back out after a short pause in presses.
	volumeVisible = $state(false);
	private static readonly VOLUME_STEP = 0.1;
	private static readonly MAX_VOLUME = 2;
	private static readonly VOLUME_HIDE_AFTER_MS = 1200;
	private volumeHideTimeout: ReturnType<typeof setTimeout> | undefined;
	private port: SerialPort | null = null;
	private reader: ReadableStreamDefaultReader<string> | null = null;
	private readableClosed: Promise<void> | null = null;
	private writer: WritableStreamDefaultWriter<string> | null = null;
	private writableClosed: Promise<void> | null = null;
	private playerByMac = new Map<string, number>();
	private nextEventId = 0;
	private flashTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
	private audioCtx: AudioContext | null = null;
	// Badges ping every ~3s even when idle (see main.c), so anything quiet
	// for longer than this has gone out of range or lost power.
	private static readonly DISCONNECT_AFTER_MS = 5000;
	private lastSeenByMac = new Map<string, number>();
	private livenessInterval: ReturnType<typeof setInterval> | undefined;

	private playTone(freq: number) {
		if (!this.audioCtx) return;
		const osc = this.audioCtx.createOscillator();
		const gain = this.audioCtx.createGain();
		osc.type = 'sine';
		osc.frequency.value = freq;

		const now = this.audioCtx.currentTime;
		// exponentialRampToValueAtTime throws if it ramps from exactly 0, so the
		// peak floors at 0.0001 (effectively silent at volume 0) rather than 0.
		const peak = Math.max(0.3 * this.volume, 0.0001);
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(peak, now + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

		osc.connect(gain).connect(this.audioCtx.destination);
		osc.start(now);
		osc.stop(now + 0.4);
	}

	private playerFor(mac: string): number {
		let player = this.playerByMac.get(mac);
		if (player === undefined) {
			player = this.playerByMac.size + 1;
			this.playerByMac.set(mac, player);
		}
		return player;
	}

	private touchSeen(mac: string) {
		this.lastSeenByMac.set(mac, Date.now());
	}

	// A badge's slot/creature (playerByMac/creatureByMac) is permanent for the
	// session - going quiet only clears the visible "joined" state, so a badge
	// that comes back lands right back in the same spot instead of taking a
	// new one.
	private checkLiveness() {
		const cutoff = Date.now() - GameState.DISCONNECT_AFTER_MS;
		let next: Map<number, PlayerState> | undefined;
		for (const [mac, lastSeen] of this.lastSeenByMac) {
			if (lastSeen > cutoff) continue;
			const player = this.playerByMac.get(mac);
			if (player === undefined) continue;
			if (!(next ?? this.playerStates).has(player)) continue;
			next ??= new Map(this.playerStates);
			next.delete(player);
		}
		if (next) this.playerStates = next;
	}

	private async sendLine(line: string) {
		if (!this.writer) return;
		try {
			await this.writer.write(line + '\n');
		} catch {
			// port closed mid-write - the disconnect/error path handles the rest
		}
	}

	private sendAssign(mac: string, creature: number) {
		this.sendLine(`ASSIGN,${mac},${creature}`);
	}

	// Creature is just the player slot number - slot 0 is always creature 0,
	// forever. No swapping, no reassignment: a badge's position and creature
	// are the same fixed thing for the whole session, decided once, the first
	// time it says hello.
	private handleHello(mac: string) {
		this.touchSeen(mac);
		const player = this.playerFor(mac);
		const creature = player - 1;
		if (creature >= CREATURES.length) return; // all slots already taken

		if (this.creatureByMac.get(mac) !== creature) {
			const next = new Map(this.creatureByMac);
			next.set(mac, creature);
			this.creatureByMac = next;
		}
		this.sendAssign(mac, creature);
	}

	goToPlay() {
		this.hasStartedPlay = true;
		goto('/');
	}

	// Gateway prints one of:
	//   "EVT,<mac>,<button>,<seq>", e.g. "EVT,AA:BB:CC:DD:EE:FF,A,12"
	//   "ACC,<mac>,<x>,<y>,<z>,<seq>", e.g. "ACC,AA:BB:CC:DD:EE:FF,120,-38,16200,412"
	//   "HELLO,<mac>,<seq>", e.g. "HELLO,AA:BB:CC:DD:EE:FF,3"
	//   "VOL,<UP|DOWN>,<seq>", e.g. "VOL,UP,7" - from the D1/D10 switches
	private handleLine(line: string) {
		if (line.startsWith('EVT,')) {
			this.handleButtonLine(line);
		} else if (line.startsWith('ACC,')) {
			this.handleAccelLine(line);
		} else if (line.startsWith('HELLO,')) {
			const [mac] = line.slice('HELLO,'.length).split(',');
			if (mac) this.handleHello(mac);
		} else if (line.startsWith('VOL,')) {
			const [direction] = line.slice('VOL,'.length).split(',');
			this.handleVolumeLine(direction);
		}
	}

	get volumePercent() {
		return Math.round((this.volume / GameState.MAX_VOLUME) * 100);
	}

	private handleVolumeLine(direction: string) {
		if (direction === 'UP') {
			this.volume = Math.min(GameState.MAX_VOLUME, this.volume + GameState.VOLUME_STEP);
		} else if (direction === 'DOWN') {
			this.volume = Math.max(0, this.volume - GameState.VOLUME_STEP);
		} else {
			return;
		}

		this.volumeVisible = true;
		clearTimeout(this.volumeHideTimeout);
		this.volumeHideTimeout = setTimeout(() => {
			this.volumeVisible = false;
		}, GameState.VOLUME_HIDE_AFTER_MS);
	}

	private handleButtonLine(line: string) {
		const parts = line.slice('EVT,'.length).split(',');
		if (parts.length !== 3) return;
		const [mac, button] = parts;
		if (!mac || !button) return;
		this.touchSeen(mac);

		// Button picks the scale degree as always; creature (if assigned yet)
		// shifts that note's register up/down to its own "call".
		const creature = this.creatureByMac.get(mac);
		const { note, freq } = noteForButton(button);
		const pitch = creature !== undefined ? freq * CREATURES[creature].pitchMultiplier : freq;

		const entry: ButtonPress = {
			id: this.nextEventId++,
			mac,
			button,
			note,
			creature,
			player: this.playerFor(mac),
			time: new Date().toLocaleTimeString()
		};

		this.events = [entry, ...this.events].slice(0, 50);
		this.playTone(pitch);

		const next = new Map(this.playerStates);
		next.set(entry.player, { ...entry, flash: true });
		this.playerStates = next;

		clearTimeout(this.flashTimeouts.get(entry.player));
		this.flashTimeouts.set(
			entry.player,
			setTimeout(() => {
				const cleared = new Map(this.playerStates);
				const state = cleared.get(entry.player);
				if (state) cleared.set(entry.player, { ...state, flash: false });
				this.playerStates = cleared;
			}, 200)
		);
	}

	private handleAccelLine(line: string) {
		const parts = line.slice('ACC,'.length).split(',');
		if (parts.length !== 5) return;
		const [mac, xStr, yStr, zStr] = parts;
		if (!mac) return;
		this.touchSeen(mac);

		const x = Number(xStr);
		const y = Number(yStr);
		const z = Number(zStr);
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

		this.latestAccel = {
			mac,
			player: this.playerFor(mac),
			x,
			y,
			z,
			time: new Date().toLocaleTimeString()
		};
	}

	private async readLoop() {
		if (!this.port?.readable) return;
		const textDecoder = new TextDecoderStream();
		this.readableClosed = this.port.readable
			.pipeTo(textDecoder.writable as WritableStream<Uint8Array>)
			.catch(() => {});
		this.reader = textDecoder.readable.getReader();

		let buffer = '';
		try {
			while (true) {
				const { value, done } = await this.reader.read();
				if (done) break;
				buffer += value;
				let idx: number;
				while ((idx = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, idx).trim();
					buffer = buffer.slice(idx + 1);
					if (line) this.handleLine(line);
				}
			}
		} catch {
			// Read errors happen naturally when the port is closed or unplugged.
		} finally {
			this.status = 'disconnected';
		}
	}

	async connect() {
		if (!navigator.serial) {
			this.status = 'error';
			this.errorMessage =
				'Web Serial is not supported in this browser. Use Chrome or Edge on desktop.';
			return;
		}

		this.status = 'connecting';
		this.errorMessage = '';

		if (!this.audioCtx) {
			this.audioCtx = new AudioContext();
		}

		try {
			this.port = await navigator.serial.requestPort({ filters: [{ usbVendorId: USB_VENDOR_ID }] });
			await this.port.open({ baudRate: 115200 });
			this.status = 'connected';

			if (this.port.writable) {
				const textEncoder = new TextEncoderStream();
				this.writableClosed = textEncoder.readable.pipeTo(this.port.writable).catch(() => {});
				this.writer = textEncoder.writable.getWriter();
			}

			// Fresh game session: forget any players/events from a prior connection.
			this.playerByMac.clear();
			this.lastSeenByMac.clear();
			this.playerStates = new Map();
			this.creatureByMac = new Map();
			this.events = [];
			this.hasStartedPlay = false;
			goto('/');

			clearInterval(this.livenessInterval);
			this.livenessInterval = setInterval(() => this.checkLiveness(), 1000);

			this.readLoop();
		} catch (err) {
			this.status = 'error';
			this.errorMessage = err instanceof Error ? err.message : 'Failed to connect';
		}
	}

	async disconnect() {
		clearInterval(this.livenessInterval);
		this.livenessInterval = undefined;
		clearTimeout(this.volumeHideTimeout);
		this.volumeVisible = false;
		try {
			await this.reader?.cancel();
		} catch {
			// ignore - cancelling an already-closed reader is fine
		}
		await this.readableClosed?.catch(() => {});
		try {
			// port.close() waits for the writable side too, so a locked writer
			// hangs it forever - release it first.
			await this.writer?.close();
		} catch {
			// ignore - closing an already-closed writer is fine
		}
		await this.writableClosed?.catch(() => {});
		try {
			await this.port?.close();
		} catch {
			// ignore - closing an already-closed port is fine
		}
		this.port = null;
		this.reader = null;
		this.writer = null;
		this.status = 'disconnected';
	}
}

export const gameState = new GameState();
