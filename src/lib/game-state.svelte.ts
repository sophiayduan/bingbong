import { goto } from '$app/navigation';
import { rhythmGame } from './rhythm/rhythm-state.svelte';

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
	// player -> total score. Only ever goes up: misses simply award nothing,
	// there's no penalty, so a player's score is a running record of their
	// best hits rather than something a bad run can knock back down.
	scores = $state<Map<number, number>>(new Map());

	hasStartedPlay = $state(false);
	// Increments on every NEXT line (the D7 local switch). +page.svelte
	// watches this to trigger the same handler as clicking the Next button,
	// since the slide animation needs a DOM ref this class doesn't have.
	nextRequested = $state(0);
	// Toggled by the GOOSE line (all 7 local switches on the XIAO held down
	// at once). Placeholder for a real separate game mode - for now it just
	// flips a flag the UI can show a banner for.
	gooseMode = $state(false);
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
	// True only for the "3, 2, 1, go" beat between entering game mode and
	// notes actually being live - button presses are ignored while this is
	// true so an early mash can't score before anything's actually falling.
	countingDown = $state(false);
	// Seconds left in the match, counting down from MATCH_DURATION_S once GO
	// fires. null before the match starts / after a fresh connect, so the
	// on-screen clock only shows up during actual play.
	matchSecondsRemaining = $state<number | null>(null);
	private static readonly MATCH_DURATION_S = 20;
	private matchTimerId: ReturnType<typeof setInterval> | undefined;
	private port: SerialPort | null = null;
	private reader: ReadableStreamDefaultReader<string> | null = null;
	private readableClosed: Promise<void> | null = null;
	private writer: WritableStreamDefaultWriter<string> | null = null;
	private writableClosed: Promise<void> | null = null;
	private playerByMac = new Map<string, number>();
	private nextEventId = 0;
	private flashTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
	private audioCtx: AudioContext | null = null;
	// Badges ping every ~1s even when idle (see main.c), so anything quiet
	// for longer than this has gone out of range or lost power.
	private static readonly DISCONNECT_AFTER_MS = 2000;
	private lastSeenByMac = new Map<string, number>();
	private livenessInterval: ReturnType<typeof setInterval> | undefined;

	// Background beat: 90 BPM, 4/4, 16 steps/bar - kick on 1 & 9, snare on
	// 5 & 13, hi-hat on every odd step (straight 8ths). Decoded from
	// https://www.musicca.com/drum-machine#data=90-n-44-a--5acegikmo6em7ai-
	// (Musicca has no audio export, only URL-encoded patterns, so this is
	// resynthesized rather than downloaded - it also keeps the beat on the
	// same procedural-audio approach as every other sound in the game).
	// Step indices are 0-based here (URL letters a-p are 1-based).
	private static readonly BEAT_BPM = 90;
	private static readonly BEAT_STEPS = 16;
	private static readonly KICK_STEPS = [0, 8];
	private static readonly SNARE_STEPS = [4, 12];
	private static readonly HIHAT_STEPS = [0, 2, 4, 6, 8, 10, 12, 14];
	// Standard Web Audio "lookahead" scheduler: a coarse setInterval just
	// checks whether it's time to schedule anything, but the actual sounds
	// are scheduled via osc.start(<precise audioCtx time>) a bit ahead of
	// now - firing sounds directly off the interval instead would drift/
	// jitter audibly, since JS timers aren't sample-accurate.
	private static readonly BEAT_SCHEDULE_AHEAD_S = 0.1;
	private static readonly BEAT_SCHEDULE_INTERVAL_MS = 25;
	private beatSchedulerId: ReturnType<typeof setInterval> | undefined;
	private beatStepIndex = 0;
	private beatNextStepTime = 0;
	private noiseBufferCache: AudioBuffer | null = null;

	private playTone(freq: number, duration = 0.4) {
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
		gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

		osc.connect(gain).connect(this.audioCtx.destination);
		osc.start(now);
		osc.stop(now + duration);
	}

	// Sawtooth through a low lowpass, quick pluck decay - reads as a plucked
	// electric bass string rather than a synth blip.
	private playBassTone(freq: number, duration = 0.35) {
		if (!this.audioCtx) return;
		const osc = this.audioCtx.createOscillator();
		const filter = this.audioCtx.createBiquadFilter();
		const gain = this.audioCtx.createGain();
		osc.type = 'sawtooth';
		osc.frequency.value = freq;
		filter.type = 'lowpass';
		filter.frequency.value = 900;
		filter.Q.value = 1;

		const now = this.audioCtx.currentTime;
		const peak = Math.max(0.35 * this.volume, 0.0001);
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(peak, now + 0.008);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

		osc.connect(filter).connect(gain).connect(this.audioCtx.destination);
		osc.start(now);
		osc.stop(now + duration);
	}

	// Sawtooth with a slow bowed attack, a bandpass tuned above the
	// fundamental for stringiness, and a pitch-vibrato LFO - reads as a
	// bowed violin note rather than a struck one.
	private playViolinTone(freq: number, duration = 0.6) {
		if (!this.audioCtx) return;
		const osc = this.audioCtx.createOscillator();
		const vibrato = this.audioCtx.createOscillator();
		const vibratoGain = this.audioCtx.createGain();
		const filter = this.audioCtx.createBiquadFilter();
		const gain = this.audioCtx.createGain();
		osc.type = 'sawtooth';
		osc.frequency.value = freq;
		vibrato.type = 'sine';
		vibrato.frequency.value = 5.5;
		vibratoGain.gain.value = freq * 0.01;
		vibrato.connect(vibratoGain).connect(osc.frequency);
		filter.type = 'bandpass';
		filter.frequency.value = freq * 2;
		filter.Q.value = 3;

		const now = this.audioCtx.currentTime;
		const peak = Math.max(0.28 * this.volume, 0.0001);
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(peak, now + 0.08);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

		osc.connect(filter).connect(gain).connect(this.audioCtx.destination);
		osc.start(now);
		vibrato.start(now);
		osc.stop(now + duration);
		vibrato.stop(now + duration);
	}

	// Square wave (rich in odd harmonics) through a sharp resonant bandpass
	// and a fast attack - reads as a bright brassy trumpet stab.
	private playTrumpetTone(freq: number, duration = 0.4) {
		if (!this.audioCtx) return;
		const osc = this.audioCtx.createOscillator();
		const filter = this.audioCtx.createBiquadFilter();
		const gain = this.audioCtx.createGain();
		osc.type = 'square';
		osc.frequency.value = freq;
		filter.type = 'bandpass';
		filter.frequency.value = freq * 3;
		filter.Q.value = 6;

		const now = this.audioCtx.currentTime;
		const peak = Math.max(0.3 * this.volume, 0.0001);
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(peak, now + 0.015);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

		osc.connect(filter).connect(gain).connect(this.audioCtx.destination);
		osc.start(now);
		osc.stop(now + duration);
	}

	// Picks the instrument voice by creature - see CREATURES for the
	// index/name mapping (0 Cat, 1 Baby Chick, 2 Canada Goose, 3 Turkey).
	// Baby Chick (and anyone not yet assigned a creature) keeps the original
	// default tone.
	private playCreatureTone(freq: number, creature: number | undefined) {
		if (creature === 0) return this.playBassTone(freq); // Cat -> electric bass
		if (creature === 2) return this.playViolinTone(freq); // Canada Goose -> violin
		if (creature === 3) return this.playTrumpetTone(freq); // Turkey -> trumpet
		this.playTone(freq); // Baby Chick -> default
	}

	// Seconds on the same clock chart note times and press timestamps are
	// measured against - see rhythm/rhythm-state.svelte.ts. Lazily creates
	// the AudioContext so this works even before/without connect() (e.g.
	// the dev Next button or keyboard input, with no badge ever attached).
	now(): number {
		if (!this.audioCtx) this.audioCtx = new AudioContext();
		return this.audioCtx.currentTime;
	}

	playCountdownTick() {
		this.playTone(660, 0.15);
	}

	// A brighter triad instead of another single blip, so GO reads as a
	// distinct "the game just started" beat rather than one more tick.
	playGoSound() {
		[523.25, 659.25, 783.99].forEach((freq) => this.playTone(freq, 0.5));
	}

	// One second of white noise, generated once and reused for every snare/
	// hi-hat hit rather than allocating a fresh buffer per hit for the whole
	// song.
	private noiseBuffer(): AudioBuffer | null {
		if (!this.audioCtx) return null;
		if (!this.noiseBufferCache) {
			const buffer = this.audioCtx.createBuffer(1, this.audioCtx.sampleRate, this.audioCtx.sampleRate);
			const data = buffer.getChannelData(0);
			for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
			this.noiseBufferCache = buffer;
		}
		return this.noiseBufferCache;
	}

	private playKick(time: number) {
		if (!this.audioCtx) return;
		const osc = this.audioCtx.createOscillator();
		const gain = this.audioCtx.createGain();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(150, time);
		osc.frequency.exponentialRampToValueAtTime(50, time + 0.12);

		const peak = Math.max(0.6 * this.volume, 0.0001);
		gain.gain.setValueAtTime(peak, time);
		gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.15);

		osc.connect(gain).connect(this.audioCtx.destination);
		osc.start(time);
		osc.stop(time + 0.15);
	}

	private playSnare(time: number) {
		if (!this.audioCtx) return;
		const buffer = this.noiseBuffer();
		if (!buffer) return;
		const noise = this.audioCtx.createBufferSource();
		noise.buffer = buffer;
		const bandpass = this.audioCtx.createBiquadFilter();
		bandpass.type = 'bandpass';
		bandpass.frequency.value = 1800;
		const gain = this.audioCtx.createGain();

		const peak = Math.max(0.35 * this.volume, 0.0001);
		gain.gain.setValueAtTime(peak, time);
		gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.15);

		noise.connect(bandpass).connect(gain).connect(this.audioCtx.destination);
		noise.start(time);
		noise.stop(time + 0.15);
	}

	private playHihat(time: number) {
		if (!this.audioCtx) return;
		const buffer = this.noiseBuffer();
		if (!buffer) return;
		const noise = this.audioCtx.createBufferSource();
		noise.buffer = buffer;
		const highpass = this.audioCtx.createBiquadFilter();
		highpass.type = 'highpass';
		highpass.frequency.value = 7000;
		const gain = this.audioCtx.createGain();

		const peak = Math.max(0.15 * this.volume, 0.0001);
		gain.gain.setValueAtTime(peak, time);
		gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);

		noise.connect(highpass).connect(gain).connect(this.audioCtx.destination);
		noise.start(time);
		noise.stop(time + 0.05);
	}

	private scheduleBeatStep(step: number, time: number) {
		if (GameState.KICK_STEPS.includes(step)) this.playKick(time);
		if (GameState.SNARE_STEPS.includes(step)) this.playSnare(time);
		if (GameState.HIHAT_STEPS.includes(step)) this.playHihat(time);
	}

	// Starts the background beat looping indefinitely; call stopBeatLoop() to
	// end it (there's no fixed length - it just keeps going until stopped).
	startBeatLoop() {
		this.stopBeatLoop();
		if (!this.audioCtx) this.audioCtx = new AudioContext();

		const secondsPerStep = 60 / GameState.BEAT_BPM / 4; // 16th notes
		this.beatStepIndex = 0;
		this.beatNextStepTime = this.audioCtx.currentTime + 0.05;

		this.beatSchedulerId = setInterval(() => {
			if (!this.audioCtx) return;
			while (this.beatNextStepTime < this.audioCtx.currentTime + GameState.BEAT_SCHEDULE_AHEAD_S) {
				this.scheduleBeatStep(this.beatStepIndex, this.beatNextStepTime);
				this.beatNextStepTime += secondsPerStep;
				this.beatStepIndex = (this.beatStepIndex + 1) % GameState.BEAT_STEPS;
			}
		}, GameState.BEAT_SCHEDULE_INTERVAL_MS);
	}

	stopBeatLoop() {
		clearInterval(this.beatSchedulerId);
		this.beatSchedulerId = undefined;
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

	// Guarded so the countdown can only ever be kicked off once per session -
	// without this, the auto-start-at-4-players check and a manual Next
	// click could theoretically both fire it (e.g. the 4th player joins the
	// instant the button's clicked) and restart the sequence mid-count.
	startCountdown() {
		if (this.countingDown) return;
		this.countingDown = true;
	}

	endCountdown() {
		this.countingDown = false;
	}

	// Starts the 20-second match clock - call once, right at GO (see
	// Countdown.svelte). Ticks once a second; when it reaches 0 the match
	// ends the same way as the chart simply running out (see endMatch).
	startMatchTimer() {
		this.stopMatchTimer();
		this.matchSecondsRemaining = GameState.MATCH_DURATION_S;
		this.matchTimerId = setInterval(() => {
			if (this.matchSecondsRemaining === null) return;
			this.matchSecondsRemaining = Math.max(0, this.matchSecondsRemaining - 1);
			if (this.matchSecondsRemaining === 0) this.endMatch();
		}, 1000);
	}

	stopMatchTimer() {
		clearInterval(this.matchTimerId);
		this.matchTimerId = undefined;
	}

	private endMatch() {
		this.stopMatchTimer();
		this.stopBeatLoop();
		rhythmGame.end();
	}

	// Awards points for a hit's timing accuracy; call with 0 (or don't call at
	// all) on a miss. Negative/zero points are ignored so score can't go down.
	awardPoints(player: number, points: number) {
		if (points <= 0) return;
		const next = new Map(this.scores);
		next.set(player, (next.get(player) ?? 0) + points);
		this.scores = next;
	}

	// Gateway prints one of:
	//   "EVT,<mac>,<button>,<seq>", e.g. "EVT,AA:BB:CC:DD:EE:FF,A,12"
	//   "ACC,<mac>,<x>,<y>,<z>,<seq>", e.g. "ACC,AA:BB:CC:DD:EE:FF,120,-38,16200,412"
	//   "HELLO,<mac>,<seq>", e.g. "HELLO,AA:BB:CC:DD:EE:FF,3"
	//   "VOL,<UP|DOWN>,<seq>", e.g. "VOL,UP,7" - from the D1/D10 switches
	//   "NEXT,<seq>", e.g. "NEXT,8" - from the D7 switch specifically
	//   "GOOSE,<seq>", e.g. "GOOSE,9" - all 7 local switches held at once
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
		} else if (line.startsWith('NEXT,')) {
			this.nextRequested++;
		} else if (line.startsWith('GOOSE,')) {
			this.gooseMode = !this.gooseMode;
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
		this.registerButtonPress(mac, this.playerFor(mac), button, this.creatureByMac.get(mac));
	}

	// Dev-only stand-in for a real badge press (keyboard input, no hardware
	// attached) - see DevKeyboardInput.svelte. Goes straight to a chosen
	// player slot instead of resolving one from a mac address.
	simulateButtonPress(player: number, button: string) {
		const creature = player - 1 < CREATURES.length ? player - 1 : undefined;
		this.registerButtonPress(`KEYBOARD:${player}`, player, button, creature);
	}

	private registerButtonPress(
		mac: string,
		player: number,
		button: string,
		creature: number | undefined
	) {
		// Ignore presses entirely during the pre-game countdown - no tone, no
		// flash, no scoring, so an early mash can't sneak in before play starts.
		if (this.countingDown) return;

		// Button picks the scale degree as always; creature (if assigned yet)
		// shifts that note's register up/down to its own "call".
		const { note, freq } = noteForButton(button);
		const pitch = creature !== undefined ? freq * CREATURES[creature].pitchMultiplier : freq;

		const entry: ButtonPress = {
			id: this.nextEventId++,
			mac,
			button,
			note,
			creature,
			player,
			time: new Date().toLocaleTimeString()
		};

		this.events = [entry, ...this.events].slice(0, 50);
		this.playCreatureTone(pitch, creature);

		if (this.hasStartedPlay) {
			rhythmGame.tryHit(entry.player, button, this.now());
		}

		const next = new Map(this.playerStates);
		next.set(entry.player, { ...entry, flash: true });
		this.playerStates = next;

		// Auto-start once every slot has thrown at least one press - no need
		// to wait on the Next button if the whole table's already playing.
		// There's no click to hang a move-animation off here, so this skips
		// straight to the countdown instead of the Next button's FLIP tween.
		if (!this.hasStartedPlay && this.playerStates.size >= CREATURES.length) {
			this.goToPlay();
			this.startCountdown();
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
			this.scores = new Map();
			this.hasStartedPlay = false;
			this.gooseMode = false;
			this.countingDown = false;
			this.stopMatchTimer();
			this.matchSecondsRemaining = null;
			rhythmGame.stop();
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
		this.stopBeatLoop();
		this.stopMatchTimer();
		this.matchSecondsRemaining = null;
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
