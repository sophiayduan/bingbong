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
// and creature_banners.h, which must list creatures in this same order.
// Each creature shifts every button's scale note by this multiplier (its
// "call" register) - the button still picks which scale degree plays.
export const CREATURES = [
	{ name: 'Canada Goose', pitchMultiplier: 0.5 }, // down an octave: low honk
	{ name: 'Cat', pitchMultiplier: 1 },
	{ name: 'Turkey', pitchMultiplier: 0.75 }, // down a fourth: gobble register
	{ name: 'Baby Chick', pitchMultiplier: 2 } // up an octave: high peep
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

export const JOIN_SECONDS = 10;
export const MAX_PLAYERS = PLAYER_COLORS.length;

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
	secondsLeft = $state(JOIN_SECONDS);
	// mac -> creature id (0-3). Separate from playerStates: a badge gets a
	// creature the instant it HELLOs (before anyone's pressed a button), and
	// player numbers are still join order, not creature identity.
	creatureByMac = $state<Map<string, number>>(new Map());

	private hasStartedPlay = false;
	private port: SerialPort | null = null;
	private reader: ReadableStreamDefaultReader<string> | null = null;
	private readableClosed: Promise<void> | null = null;
	private writer: WritableStreamDefaultWriter<string> | null = null;
	private writableClosed: Promise<void> | null = null;
	private playerByMac = new Map<string, number>();
	private nextEventId = 0;
	private flashTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
	private audioCtx: AudioContext | null = null;
	private countdownInterval: ReturnType<typeof setInterval> | undefined;

	private playTone(freq: number) {
		if (!this.audioCtx) return;
		const osc = this.audioCtx.createOscillator();
		const gain = this.audioCtx.createGain();
		osc.type = 'sine';
		osc.frequency.value = freq;

		const now = this.audioCtx.currentTime;
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(0.3, now + 0.01);
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

	// Assigns creature to mac. If another badge already holds it, they swap -
	// by construction there's never more than one badge per creature.
	assignCreature(mac: string, creature: number) {
		const next = new Map(this.creatureByMac);
		const previousHolder = [...next.entries()].find(
			([holderMac, id]) => id === creature && holderMac !== mac
		)?.[0];
		const displaced = next.get(mac);

		next.set(mac, creature);
		this.sendAssign(mac, creature);

		if (previousHolder !== undefined) {
			if (displaced !== undefined) {
				next.set(previousHolder, displaced);
				this.sendAssign(previousHolder, displaced);
			} else {
				// mac had no creature yet (shouldn't happen once handshake has run -
				// HELLO always beats the first possible button press) - previousHolder
				// just loses theirs, with no assign message since there's no "none".
				next.delete(previousHolder);
			}
		}

		this.creatureByMac = next;
	}

	// A HELLO either means "I'm new, give me a creature" or "I never got your
	// last ASSIGN, resend it" - same handler either way, since resending the
	// existing assignment is a no-op for a badge that already got it.
	private handleHello(mac: string) {
		const existing = this.creatureByMac.get(mac);
		if (existing !== undefined) {
			this.sendAssign(mac, existing);
			return;
		}

		const used = new Set(this.creatureByMac.values());
		const free = CREATURES.findIndex((_, id) => !used.has(id));
		if (free === -1) return; // all 4 creatures already spoken for

		this.assignCreature(mac, free);
	}

	startJoinCountdown() {
		clearInterval(this.countdownInterval);
		this.secondsLeft = JOIN_SECONDS;
		this.countdownInterval = setInterval(() => {
			this.secondsLeft -= 1;
			if (this.secondsLeft <= 0) {
				this.goToPlay();
			}
		}, 1000);
	}

	goToPlay() {
		clearInterval(this.countdownInterval);
		this.countdownInterval = undefined;
		this.hasStartedPlay = true;
		goto('/');
	}

	// Gateway prints one of:
	//   "EVT,<mac>,<button>,<seq>", e.g. "EVT,AA:BB:CC:DD:EE:FF,A,12"
	//   "ACC,<mac>,<x>,<y>,<z>,<seq>", e.g. "ACC,AA:BB:CC:DD:EE:FF,120,-38,16200,412"
	//   "HELLO,<mac>,<seq>", e.g. "HELLO,AA:BB:CC:DD:EE:FF,3"
	private handleLine(line: string) {
		if (line.startsWith('EVT,')) {
			this.handleButtonLine(line);
		} else if (line.startsWith('ACC,')) {
			this.handleAccelLine(line);
		} else if (line.startsWith('HELLO,')) {
			const [mac] = line.slice('HELLO,'.length).split(',');
			if (mac) this.handleHello(mac);
		}
	}

	private handleButtonLine(line: string) {
		const parts = line.slice('EVT,'.length).split(',');
		if (parts.length !== 3) return;
		const [mac, button] = parts;
		if (!mac || !button) return;

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

		if (!this.hasStartedPlay && this.playerStates.size >= MAX_PLAYERS) {
			this.goToPlay();
		}

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
			this.playerStates = new Map();
			this.creatureByMac = new Map();
			this.events = [];
			this.hasStartedPlay = false;
			goto('/');
			this.startJoinCountdown();

			this.readLoop();
		} catch (err) {
			this.status = 'error';
			this.errorMessage = err instanceof Error ? err.message : 'Failed to connect';
		}
	}

	async disconnect() {
		clearInterval(this.countdownInterval);
		this.countdownInterval = undefined;
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
