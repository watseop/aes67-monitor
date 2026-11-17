/**
 * Group playback: receives every member stream of a group at once, aligns the
 * packets (aligner.js) and plays them through one RtAudio output stream in the
 * selected output mode (outmap.js). Runs inside the audio child process; the
 * single-stream path in audio.js is unchanged.
 *
 * Each member has its own socket bound to its multicast address, like
 * monitor.js, so members on the same port are kept apart.
 */
const { RtAudio, RtAudioFormat } = require("audify");
const dgram = require("dgram");
const { LevelMeter } = require("./level.js");
const { rtpHeaderLength } = require("./rtp.js");
const { PacketAligner } = require("./aligner.js");
const {
	availableModes,
	outputChannelCount,
	buildRoutes,
	mixPackets,
} = require("./outmap.js");

const METER_INTERVAL_MS = 100;

let state = null;

function findDevice(rtAudio, selected) {
	const devices = rtAudio.getDevices();
	let fallback = null;
	for (const d of devices) {
		if (
			selected &&
			d.name == selected.name &&
			d.inputChannels == selected.inputChannels &&
			d.outputChannels == selected.outputChannels
		) {
			return d;
		}
		if (d.isDefaultOutput && d.outputChannels >= 1) {
			fallback = d;
		}
	}
	console.log("Group playback: falling back to default device");
	return fallback;
}

function stop() {
	if (!state) return;
	const s = state;
	state = null;
	clearInterval(s.timer);
	for (const sock of s.sockets) {
		try {
			sock.close();
		} catch (e) {
			// already closed
		}
	}
	if (s.rtAudio) {
		try {
			s.rtAudio.stop();
			s.rtAudio.clearOutputQueue();
			s.rtAudio.closeStream();
		} catch (e) {
			console.error("Group playback close error:", e.message);
		}
	}
}

/**
 * @param {Object} args - { key, streams: [member descriptors as in monitor.js],
 *   mode, pair, audioAPI, selected, networkInterface, jitterBufferEnabled,
 *   jitterBufferSize }
 */
function start(args) {
	stop();
	const streams = args.streams;
	if (!streams || streams.length === 0) return;

	// Group members share codec, rate and ptime (groups.js requires it).
	const first = streams[0];
	const frames = Math.round((first.samplerate / 1000) * first.ptime);

	const rtAudio = new RtAudio(args.audioAPI);
	const device = findDevice(rtAudio, args.selected);
	if (!device) {
		console.error("Group playback: no output device");
		return;
	}

	const groupChannels = streams.reduce((n, s) => n + s.channels, 0);
	const modes = availableModes(device.outputChannels);
	const mode = modes.includes(args.mode) ? args.mode : modes[0];
	const outChannels = outputChannelCount(
		mode,
		groupChannels,
		device.outputChannels
	);
	const routes = buildRoutes(mode, groupChannels, outChannels, args.pair);

	let offset = 0;
	const members = streams.map((s) => {
		const m = {
			channels: s.channels,
			bytesPerSample: s.codec == "L24" ? 3 : 2,
			offset,
		};
		offset += s.channels;
		return m;
	});
	const cfg = { members, routes, outChannels, frames };

	// Write at least 48 samples per call, as audio.js does.
	let factor = 1;
	while (frames * factor < 48) factor++;
	let prefill = args.jitterBufferEnabled ? args.jitterBufferSize : 0;
	if (factor > 1 && factor > prefill) prefill = factor;

	const packetBytes = frames * outChannels * 2;
	const outBuf = Buffer.alloc(packetBytes * factor);
	const acc = new Int32Array(frames * outChannels);
	let filled = 0;
	let started = false;

	const aligner = new PacketAligner(streams.length, frames);
	const meters = members.map(
		(m) => new LevelMeter(m.channels, m.bytesPerSample)
	);

	const s = { sockets: [], rtAudio: null, timer: null };
	state = s;

	const drain = () => {
		let frameSet;
		while ((frameSet = aligner.pop()) !== null) {
			if (!started) {
				started = true;
				for (let j = 0; j < prefill; j++) {
					rtAudio.write(Buffer.alloc(packetBytes * factor));
				}
			}
			mixPackets(
				outBuf.subarray(filled * packetBytes, (filled + 1) * packetBytes),
				acc,
				frameSet,
				cfg
			);
			filled++;
			if (filled === factor) {
				// RtAudio copies the data into its queue.
				rtAudio.write(outBuf);
				filled = 0;
			}
		}
	};

	streams.forEach((stream, i) => {
		const pcmDataSize = frames * members[i].bytesPerSample * stream.channels;
		const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
		socket.on("error", (err) => {
			console.error("Group playback socket error:", err.message);
		});
		socket.on("listening", () => {
			try {
				socket.addMembership(stream.mcast, args.networkInterface);
			} catch (err) {
				console.error("Group playback addMembership failed:", err.message);
			}
		});
		socket.on("message", (buffer, remote) => {
			if (state !== s) return;
			const headerLength = rtpHeaderLength(buffer);
			if (
				headerLength < 0 ||
				buffer.length != pcmDataSize + headerLength ||
				(stream.filter && remote.address != stream.filterAddr)
			) {
				return;
			}
			meters[i].push(buffer, headerLength, frames);
			// RFC 3550 §5.1: timestamp at bytes 4..7.
			aligner.push(i, buffer.readUInt32BE(4), { buffer, headerLength });
			drain();
		});
		s.sockets.push(socket);
	});

	try {
		rtAudio.openStream(
			{ deviceId: device.id, nChannels: outChannels, firstChannel: 0 },
			null,
			RtAudioFormat.RTAUDIO_SINT16,
			first.samplerate,
			frames * factor,
			"AES67 Monitor"
		);
		rtAudio.start();
		s.rtAudio = rtAudio;
	} catch (error) {
		console.error("Group playback stream setup failed:", error);
		stop();
		return;
	}

	streams.forEach((stream, i) => s.sockets[i].bind(stream.port, stream.mcast));

	s.timer = setInterval(() => {
		if (!process.connected) return;
		process.send({
			type: "groupPlayback",
			data: {
				key: args.key,
				mode,
				outChannels,
				alignment: aligner.mode,
				dropped: aligner.dropped,
				missing: aligner.missing,
				members: streams.map((st, i) =>
					Object.assign({ id: st.id }, meters[i].snapshot())
				),
			},
		});
	}, METER_INTERVAL_MS);
}

module.exports = { start, stop };
