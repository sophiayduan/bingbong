<script lang="ts">
	import { onDestroy } from 'svelte';

	// Espressif's USB vendor ID - the XIAO's native USB-JTAG/serial port
	// enumerates under this, so the picker only shows relevant devices.
	const USB_VENDOR_ID = 0x303a;

	const PLAYER_COLORS = ['bg-rose-500', 'bg-sky-500', 'bg-emerald-500', 'bg-amber-500'];

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

	type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

	type ButtonPress = {
		id: number;
		mac: string;
		button: string;
		note: string;
		player: number;
		time: string;
	};

	type AccelSample = {
		mac: string;
		player: number;
		x: number;
		y: number;
		z: number;
		time: string;
	};

	const supported = typeof navigator !== 'undefined' && !!navigator.serial;

	let status = $state<Status>('idle');
	let errorMessage = $state('');
	let events = $state<ButtonPress[]>([]);
	let latest = $state<ButtonPress | null>(null);
	let latestAccel = $state<AccelSample | null>(null);
	let flash = $state(false);

	let port: SerialPort | null = null;
	let reader: ReadableStreamDefaultReader<string> | null = null;
	let readableClosed: Promise<void> | null = null;
	const playerByMac = new Map<string, number>();
	let nextEventId = 0;
	let flashTimeout: ReturnType<typeof setTimeout> | undefined;
	let audioCtx: AudioContext | null = null;

	function playTone(freq: number) {
		if (!audioCtx) return;
		const osc = audioCtx.createOscillator();
		const gain = audioCtx.createGain();
		osc.type = 'sine';
		osc.frequency.value = freq;

		const now = audioCtx.currentTime;
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(0.3, now + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

		osc.connect(gain).connect(audioCtx.destination);
		osc.start(now);
		osc.stop(now + 0.4);
	}

	function colorFor(player: number) {
		return PLAYER_COLORS[(player - 1) % PLAYER_COLORS.length];
	}

	function playerFor(mac: string): number {
		let player = playerByMac.get(mac);
		if (player === undefined) {
			player = playerByMac.size + 1;
			playerByMac.set(mac, player);
		}
		return player;
	}

	// Gateway prints one of:
	//   "EVT,<mac>,<button>,<seq>", e.g. "EVT,AA:BB:CC:DD:EE:FF,A,12"
	//   "ACC,<mac>,<x>,<y>,<z>,<seq>", e.g. "ACC,AA:BB:CC:DD:EE:FF,120,-38,16200,412"
	function handleLine(line: string) {
		if (line.startsWith('EVT,')) {
			handleButtonLine(line);
		} else if (line.startsWith('ACC,')) {
			handleAccelLine(line);
		}
	}

	function handleButtonLine(line: string) {
		const parts = line.slice('EVT,'.length).split(',');
		if (parts.length !== 3) return;
		const [mac, button] = parts;
		if (!mac || !button) return;

		const { note, freq } = noteForButton(button);

		const entry: ButtonPress = {
			id: nextEventId++,
			mac,
			button,
			note,
			player: playerFor(mac),
			time: new Date().toLocaleTimeString()
		};

		latest = entry;
		events = [entry, ...events].slice(0, 50);
		playTone(freq);

		flash = true;
		clearTimeout(flashTimeout);
		flashTimeout = setTimeout(() => {
			flash = false;
		}, 200);
	}

	function handleAccelLine(line: string) {
		const parts = line.slice('ACC,'.length).split(',');
		if (parts.length !== 5) return;
		const [mac, xStr, yStr, zStr] = parts;
		if (!mac) return;

		const x = Number(xStr);
		const y = Number(yStr);
		const z = Number(zStr);
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

		latestAccel = {
			mac,
			player: playerFor(mac),
			x,
			y,
			z,
			time: new Date().toLocaleTimeString()
		};
	}

	async function readLoop() {
		if (!port?.readable) return;
		const textDecoder = new TextDecoderStream();
		readableClosed = port.readable
			.pipeTo(textDecoder.writable as WritableStream<Uint8Array>)
			.catch(() => {});
		reader = textDecoder.readable.getReader();

		let buffer = '';
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += value;
				let idx: number;
				while ((idx = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, idx).trim();
					buffer = buffer.slice(idx + 1);
					if (line) handleLine(line);
				}
			}
		} catch {
			// Read errors happen naturally when the port is closed or unplugged.
		} finally {
			status = 'disconnected';
		}
	}

	async function connect() {
		if (!navigator.serial) {
			status = 'error';
			errorMessage = 'Web Serial is not supported in this browser. Use Chrome or Edge on desktop.';
			return;
		}

		status = 'connecting';
		errorMessage = '';

		if (!audioCtx) {
			audioCtx = new AudioContext();
		}

		try {
			port = await navigator.serial.requestPort({ filters: [{ usbVendorId: USB_VENDOR_ID }] });
			await port.open({ baudRate: 115200 });
			status = 'connected';
			readLoop();
		} catch (err) {
			status = 'error';
			errorMessage = err instanceof Error ? err.message : 'Failed to connect';
		}
	}

	async function disconnect() {
		try {
			await reader?.cancel();
		} catch {
			// ignore - cancelling an already-closed reader is fine
		}
		await readableClosed?.catch(() => {});
		try {
			await port?.close();
		} catch {
			// ignore - closing an already-closed port is fine
		}
		port = null;
		reader = null;
		status = 'disconnected';
	}

	onDestroy(() => {
		disconnect();
	});
</script>

<main class="flex min-h-screen flex-col items-center gap-8 bg-slate-950 p-8 text-slate-100">
	<h1 class="text-3xl font-bold">Badge Input</h1>

	{#if !supported}
		<p class="max-w-md text-center text-amber-400">
			Web Serial isn't available in this browser. Use Chrome or Edge on desktop, served over
			http://localhost or https://.
		</p>
	{:else}
		<div class="flex items-center gap-3">
			{#if status === 'connected'}
				<button
					onclick={disconnect}
					class="rounded-lg bg-slate-700 px-5 py-2.5 font-medium text-white transition hover:bg-slate-600"
				>
					Disconnect
				</button>
			{:else}
				<button
					onclick={connect}
					disabled={status === 'connecting'}
					class="rounded-lg bg-sky-500 px-5 py-2.5 font-medium text-white transition hover:bg-sky-400 disabled:opacity-50"
				>
					{status === 'connecting' ? 'Connecting...' : 'Connect via USB'}
				</button>
			{/if}

			<span class="text-sm text-slate-400">
				{#if status === 'connected'}
					Connected
				{:else if status === 'disconnected'}
					Disconnected — click Connect to retry
				{:else if status === 'error'}
					{errorMessage}
				{:else if status === 'connecting'}
					Waiting for device picker...
				{:else}
					Not connected
				{/if}
			</span>
		</div>

		<div
			class="flex h-48 w-48 items-center justify-center rounded-full border-4 border-slate-800 text-6xl font-black transition-transform duration-150 {flash
				? 'scale-110'
				: 'scale-100'} {latest ? colorFor(latest.player) : 'bg-slate-900'}"
		>
			{latest ? latest.note : '--'}
		</div>
		{#if latest}
			<p class="text-slate-400">
				Player {latest.player} · button {latest.button} · {latest.mac} · {latest.time}
			</p>
		{/if}

		{#if latestAccel}
			<div class="w-full max-w-md rounded bg-slate-900 px-3 py-2 text-sm">
				<span class="flex items-center gap-2">
					<span class="h-2 w-2 rounded-full {colorFor(latestAccel.player)}"></span>
					Player {latestAccel.player} accel · x {latestAccel.x} · y {latestAccel.y} · z {latestAccel.z}
					<span class="ml-auto text-slate-500">{latestAccel.time}</span>
				</span>
			</div>
		{/if}

		<div class="w-full max-w-md">
			<h2 class="mb-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">
				Recent presses
			</h2>
			<ul class="flex flex-col gap-1">
				{#each events as e (e.id)}
					<li class="flex items-center justify-between rounded bg-slate-900 px-3 py-2 text-sm">
						<span class="flex items-center gap-2">
							<span class="h-2 w-2 rounded-full {colorFor(e.player)}"></span>
							Player {e.player} pressed <strong>{e.button}</strong> → {e.note}
						</span>
						<span class="text-slate-500">{e.time}</span>
					</li>
				{/each}
				{#if events.length === 0}
					<li class="text-sm text-slate-600">No presses yet.</li>
				{/if}
			</ul>
		</div>
	{/if}
</main>
