/**
 * Group monitor child process: receives several streams at once and reports
 * per-channel levels only (no audio output). Independent of audio.js, so it can
 * run next to a playing stream.
 *
 * Each stream gets its own UDP socket. Most AES67 sources use the same port
 * (5004) for every stream, so each socket is bound to its multicast address
 * (bind(port, mcast)) and only receives packets for that group. On macOS and
 * Linux this filters by destination address; this is NOT verified on the Mac yet.
 */
const dgram = require("dgram");
const { LevelMeter } = require("./level.js");
const { rtpHeaderLength } = require("./rtp.js");

// Same report interval as audio.js.
const METER_INTERVAL_MS = 100;

let sockets = [];
let timer = null;

function stop() {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	for (const s of sockets) {
		try {
			s.close();
		} catch (e) {
			// already closed
		}
	}
	sockets = [];
}

function openStream(stream, networkInterface) {
	const bytesPerSample = stream.codec == "L24" ? 3 : 2;
	const samplesPerPacket = Math.round(
		(stream.samplerate / 1000) * stream.ptime
	);
	const pcmDataSize = samplesPerPacket * bytesPerSample * stream.channels;
	const meter = new LevelMeter(stream.channels, bytesPerSample);

	const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
	socket.on("error", (err) => {
		console.error("Monitor socket error (" + stream.id + "):", err.message);
	});
	socket.on("listening", () => {
		try {
			socket.addMembership(stream.mcast, networkInterface);
		} catch (err) {
			console.error("Monitor addMembership failed:", err.message);
		}
	});
	socket.on("message", (buffer, remote) => {
		const headerLength = rtpHeaderLength(buffer);
		if (
			headerLength < 0 ||
			buffer.length != pcmDataSize + headerLength ||
			(stream.filter && remote.address != stream.filterAddr)
		) {
			return;
		}
		meter.push(buffer, headerLength, samplesPerPacket);
	});
	socket.bind(stream.port, stream.mcast);
	sockets.push(socket);
	return { id: stream.id, meter };
}

function start(args) {
	stop();
	const members = args.streams.map((s) => openStream(s, args.networkInterface));
	timer = setInterval(() => {
		if (process.connected) {
			process.send({
				type: "groupLevels",
				data: {
					key: args.key,
					members: members.map((m) =>
						Object.assign({ id: m.id }, m.meter.snapshot())
					),
				},
			});
		}
	}, METER_INTERVAL_MS);
}

process.on("message", (message) => {
	switch (message.type) {
		case "start":
			start(message.data);
			break;
		case "stop":
			stop();
			break;
	}
});

process.on("disconnect", () => {
	stop();
	process.exit(0);
});
