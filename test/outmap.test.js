const test = require("node:test");
const assert = require("node:assert");
const {
	availableModes,
	outputChannelCount,
	outputGain,
	buildRoutes,
	mixPackets,
} = require("../src/lib/outmap.js");

// Builds an RTP-like packet: 12 byte header + interleaved samples (big endian).
function packet(frames, values, bps) {
	const ch = values.length;
	const b = Buffer.alloc(12 + frames * ch * bps);
	for (let f = 0; f < frames; f++) {
		for (let c = 0; c < ch; c++) {
			const pos = 12 + (f * ch + c) * bps;
			b.writeInt16BE(values[c], pos); // top 16 bits for L24 too
		}
	}
	return { buffer: b, headerLength: 12 };
}

function run(mode, members, values, outDevice, pair, bps = 2) {
	const groupCh = members.reduce((n, c) => n + c, 0);
	const outCh = outputChannelCount(mode, groupCh, outDevice);
	let offset = 0;
	const cfgMembers = members.map((c) => {
		const m = { channels: c, bytesPerSample: bps, offset };
		offset += c;
		return m;
	});
	const frames = 2;
	const cfg = {
		members: cfgMembers,
		routes: buildRoutes(mode, groupCh, outCh, pair),
		outChannels: outCh,
		frames,
		gain: outputGain(mode, groupCh),
	};
	const out = Buffer.alloc(frames * outCh * 2);
	const acc = new Int32Array(frames * outCh);
	const pkts = values.map((v, i) =>
		v === null ? null : packet(frames, v, cfgMembers[i].bytesPerSample)
	);
	mixPackets(out, acc, pkts, cfg);
	const frame0 = [];
	for (let o = 0; o < outCh; o++) frame0.push(out.readInt16LE(o * 2));
	return frame0;
}

test("available modes follow the device output channel count", () => {
	assert.deepStrictEqual(availableModes(12), ["multi", "stereo", "mono"]);
	assert.deepStrictEqual(availableModes(2), ["stereo", "mono"]);
	assert.deepStrictEqual(availableModes(1), ["mono"]);
	assert.deepStrictEqual(availableModes(0), []);
});

test("multi maps 8 + 4 channels in order to 12 outputs", () => {
	const v1 = [1, 2, 3, 4, 5, 6, 7, 8];
	const v2 = [9, 10, 11, 12];
	assert.deepStrictEqual(
		run("multi", [8, 4], [v1, v2], 12),
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
	);
});

test("multi drops channels beyond the device", () => {
	assert.deepStrictEqual(
		run(
			"multi",
			[8, 4],
			[
				[1, 2, 3, 4, 5, 6, 7, 8],
				[9, 10, 11, 12],
			],
			10
		),
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
	);
});

test("stereo sends the chosen pair across members to L/R", () => {
	assert.deepStrictEqual(
		run(
			"stereo",
			[8, 4],
			[
				[1, 2, 3, 4, 5, 6, 7, 8],
				[9, 10, 11, 12],
			],
			2,
			[8, 9]
		),
		[9, 10]
	);
	assert.deepStrictEqual(
		run(
			"stereo",
			[8, 4],
			[
				[1, 2, 3, 4, 5, 6, 7, 8],
				[9, 10, 11, 12],
			],
			2
		),
		[1, 2]
	);
});

test("mono averages every channel onto all outputs", () => {
	// (100 + 200 - 50) / 3 = 83.33 -> 83
	assert.deepStrictEqual(run("mono", [2, 1], [[100, 200], [-50]], 2), [83, 83]);
	assert.deepStrictEqual(run("mono", [2, 1], [[100, 200], [-50]], 1), [83]);
	// Cannot clip: the average of full scale channels is full scale.
	assert.deepStrictEqual(run("mono", [2], [[32767, 32767]], 2), [32767, 32767]);
	assert.deepStrictEqual(
		run("mono", [2], [[-32768, -32768]], 2),
		[-32768, -32768]
	);
	// One loud channel out of 4 is a quarter of its level.
	assert.deepStrictEqual(run("mono", [4], [[8000, 0, 0, 0]], 2), [2000, 2000]);
});

test("outputGain is 1/channels for mono and 1 otherwise", () => {
	assert.strictEqual(outputGain("mono", 12), 1 / 12);
	assert.strictEqual(outputGain("mono", 1), 1);
	assert.strictEqual(outputGain("multi", 12), 1);
	assert.strictEqual(outputGain("stereo", 12), 1);
});

test("missing member is silent, L24 uses the top 16 bits", () => {
	assert.deepStrictEqual(run("multi", [2, 2], [[5, 6], null], 4), [5, 6, 0, 0]);
	assert.deepStrictEqual(run("multi", [2], [[7, -7]], 2, null, 3), [7, -7]);
});

test("short packet is skipped instead of read out of bounds", () => {
	const cfg = {
		members: [{ channels: 2, bytesPerSample: 2, offset: 0 }],
		routes: buildRoutes("multi", 2, 2),
		outChannels: 2,
		frames: 4,
	};
	const out = Buffer.alloc(16);
	mixPackets(
		out,
		new Int32Array(8),
		[{ buffer: Buffer.alloc(14), headerLength: 12 }],
		cfg
	);
	assert.ok(out.equals(Buffer.alloc(16)));
});
