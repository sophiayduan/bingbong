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

export type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export type ButtonPress = {
	id: number;
	mac: string;
	button: string;
	note: string;
	player: number;
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

	private hasStartedPlay = false;
	private port: SerialPort | null = null;
	private reader: ReadableStreamDefaultReader<string> | null = null;
	private readableClosed: Promise<void> | null = null;
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
		goto('/play');
	}

	// Gateway prints one of:
	//   "EVT,<mac>,<button>,<seq>", e.g. "EVT,AA:BB:CC:DD:EE:FF,A,12"
	//   "ACC,<mac>,<x>,<y>,<z>,<seq>", e.g. "ACC,AA:BB:CC:DD:EE:FF,120,-38,16200,412"
	private handleLine(line: string) {
		if (line.startsWith('EVT,')) {
			this.handleButtonLine(line);
		} else if (line.startsWith('ACC,')) {
			this.handleAccelLine(line);
		}
	}

	private handleButtonLine(line: string) {
		const parts = line.slice('EVT,'.length).split(',');
		if (parts.length !== 3) return;
		const [mac, button] = parts;
		if (!mac || !button) return;

		const { note, freq } = noteForButton(button);

		const entry: ButtonPress = {
			id: this.nextEventId++,
			mac,
			button,
			note,
			player: this.playerFor(mac),
			time: new Date().toLocaleTimeString()
		};

		this.events = [entry, ...this.events].slice(0, 50);
		this.playTone(freq);

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
			this.errorMessage = 'Web Serial is not supported in this browser. Use Chrome or Edge on desktop.';
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

			// Fresh game session: forget any players/events from a prior connection.
			this.playerByMac.clear();
			this.playerStates = new Map();
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
			await this.port?.close();
		} catch {
			// ignore - closing an already-closed port is fine
		}
		this.port = null;
		this.reader = null;
		this.status = 'disconnected';
	}
}

export const gameState = new GameState();
