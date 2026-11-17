const { RtAudio, RtAudioFormat } = require("audify");
const dgram = require("dgram");
const { LevelMeter } = require("./level.js");

let rtAudio;
let client;
let streamOpen = false;
let argsCache;
let meterTimer = null;

// Level meter report interval. 100 ms keeps IPC traffic at 10 msg/s while the
// meter still reacts quickly; packets are only accumulated in the UDP callback.
const METER_INTERVAL_MS = 100;

const stopMeter = function () {
	if (meterTimer) {
		clearInterval(meterTimer);
		meterTimer = null;
	}
};

const start = function (args) {
	argsCache = args;
	stopMeter();
	if (streamOpen) {
		streamOpen = false;
		client.close();
		rtAudio.stop();
		rtAudio.clearOutputQueue();
		rtAudio.closeStream();
	}

	client = dgram.createSocket({ type: "udp4", reuseAddr: true });

	// Error handling
	client.on("error", (err) => {
		console.error(`Socket error: ${err.stack}`);
	});

	client.on("listening", function () {
		client.addMembership(args.mcast, args.networkInterface);
	});

	// Constants
	const bufferSize = 1024;
	const samplesPerPacket = Math.round((args.samplerate / 1000) * args.ptime);
	const bytesPerSample = args.codec == "L24" ? 3 : 2;
	const pcmDataSize = samplesPerPacket * bytesPerSample * args.channels;
	const pcmL16out = Buffer.alloc(samplesPerPacket * 4 * bufferSize);

	// Meters every channel of the stream (not only the two routed to the output)
	// so a silent source channel is visible.
	const meter = new LevelMeter(args.channels, bytesPerSample);
	meterTimer = setInterval(() => {
		if (process.connected) {
			process.send({
				type: "levels",
				data: Object.assign({ id: args.id }, meter.snapshot()),
			});
		}
	}, METER_INTERVAL_MS);

	let jitterBufferSize = args.jitterBufferEnabled ? args.jitterBufferSize : 0;
	let outSampleFactor = 1;
	let seqInternal = -1;

	// Play it safe and write 48 samples at minimum
	while (samplesPerPacket * outSampleFactor < 48) {
		outSampleFactor++;
	}

	console.log("Output sample factor:", outSampleFactor);

	if (outSampleFactor > 1 && outSampleFactor > jitterBufferSize) {
		jitterBufferSize = outSampleFactor;
		console.log("Increasing jitter buffer size", jitterBufferSize);
	}

	client.on("message", function (buffer, remote) {
		const firstByte = buffer.readUInt8(0);
		const csrcCount = firstByte & 0x0f;
		let headerLength = 12 + csrcCount * 4;
		const extensionFlag = (firstByte >> 4) & 0x01;

		if (extensionFlag) {
			let extIndex = 12 + csrcCount * 4;
			const extensionLength = buffer.readUInt16BE(extIndex + 2);
			headerLength += 4 + extensionLength * 4;
		}

		if (
			buffer.length != pcmDataSize + headerLength ||
			(args.filter && remote.address != args.filterAddr)
		) {
			return;
		}

		// Packet length was validated above, so the meter stays within bounds.
		meter.push(buffer, headerLength, samplesPerPacket);

		let seqNum = buffer.readUInt16BE(2);
		let bufferIndex = (seqNum % bufferSize) * samplesPerPacket * 4;

		for (let sample = 0; sample < samplesPerPacket; sample++) {
			pcmL16out.writeUInt16LE(
				buffer.readUInt16BE(
					(sample * args.channels + args.ch1Map) * bytesPerSample + headerLength
				),
				sample * 4 + bufferIndex
			);
			pcmL16out.writeUInt16LE(
				buffer.readUInt16BE(
					(sample * args.channels + args.ch2Map) * bytesPerSample + headerLength
				),
				sample * 4 + bufferIndex + 2
			);
		}

		if (seqInternal != -1) {
			if (outSampleFactor == 1 || seqInternal % outSampleFactor == 0) {
				let bufferIndex = seqInternal * samplesPerPacket * 4;
				let outBuf = pcmL16out.subarray(
					bufferIndex,
					bufferIndex + samplesPerPacket * 4 * outSampleFactor
				);
				rtAudio.write(outBuf);
			}
			seqInternal = (seqInternal + 1) % bufferSize;
		} else {
			seqInternal = (seqNum - jitterBufferSize) % bufferSize;

			for (var j = 0; j < jitterBufferSize; j++) {
				try {
					rtAudio.write(Buffer.alloc(samplesPerPacket * 4 * outSampleFactor));
				} catch (error) {
					console.error("Error writing sample:", error);
				}
			}
		}
	});

	rtAudio = new RtAudio(args.audioAPI);
	let devices = rtAudio.getDevices();
	let id;
	let found = false;
	let defaultOutputDevice;

	for (let i = 0; i < devices.length; i++) {
		if (
			devices[i].name == args.selected.name &&
			devices[i].inputChannels == args.selected.inputChannels &&
			devices[i].outputChannels == args.selected.outputChannels
		) {
			console.log("Found device: " + devices[i].name);
			id = devices[i].id;
			found = true;
			break;
		}

		if (devices[i].isDefaultOutput && devices[i].outputChannels >= 2) {
			defaultOutputDevice = devices[i];
		}
	}

	if (!found) {
		console.log("Falling back to default device");
		id = defaultOutputDevice.id;
	}

	try {
		rtAudio.openStream(
			{ deviceId: id, nChannels: 2, firstChannel: 0 },
			null,
			RtAudioFormat.RTAUDIO_SINT16,
			args.samplerate,
			samplesPerPacket * outSampleFactor,
			"AES67 Monitor"
		);
		rtAudio.start();
		// Bind to the stream's own multicast address, not the wildcard address:
		// group memberships are host-wide (e.g. the group monitor joins other
		// groups), and a wildcard socket on this port would also receive those
		// packets and mix them into playback.
		client.bind(args.port, args.mcast);
		streamOpen = true;
	} catch (error) {
		stopMeter();
		console.error("Error during stream setup:", error);
	}
};

const restart = (args) => {
	if (streamOpen) {
		argsCache = Object.assign({}, argsCache, args);
		start(argsCache);
	}
};

const stop = function () {
	stopMeter();
	if (streamOpen) {
		streamOpen = false;
		client.close();
		rtAudio.stop();
		rtAudio.clearOutputQueue();
		rtAudio.closeStream();
	}
};

process.on("message", (message) => {
	switch (message.type) {
		case "start":
			start(message.data);
			break;
		case "restart":
			restart(message.data);
			break;
		case "stop":
			stop();
			break;
	}
});

process.on("disconnect", () => {
	process.exit(0);
});
