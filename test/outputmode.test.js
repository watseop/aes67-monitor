const test = require("node:test");
const assert = require("node:assert");
const m = require("../src/lib/outputmode.js");

test("availableModes by output channel count", () => {
	assert.deepStrictEqual(m.availableModes(0), []);
	assert.deepStrictEqual(m.availableModes(1), ["mono"]);
	assert.deepStrictEqual(m.availableModes(2), ["stereo", "mono"]);
	assert.deepStrictEqual(m.availableModes(12), [
		"multichannel",
		"stereo",
		"mono",
	]);
});

test("resolveMode keeps a valid request and falls back to the default", () => {
	assert.strictEqual(m.resolveMode("mono", 12), "mono");
	assert.strictEqual(m.resolveMode("multichannel", 2), "stereo");
	assert.strictEqual(m.resolveMode("stereo", 1), "mono");
	assert.strictEqual(m.resolveMode(undefined, 8), "multichannel");
	assert.strictEqual(m.resolveMode("stereo", 0), null);
});

test("outputChannelCount", () => {
	assert.strictEqual(m.outputChannelCount("multichannel", 12, 16), 12);
	assert.strictEqual(m.outputChannelCount("multichannel", 12, 8), 8);
	assert.strictEqual(m.outputChannelCount("multichannel", 1, 8), 2);
	assert.strictEqual(m.outputChannelCount("stereo", 12, 8), 2);
	assert.strictEqual(m.outputChannelCount("mono", 12, 8), 2);
	assert.strictEqual(m.outputChannelCount("mono", 12, 1), 1);
	assert.throws(() => m.outputChannelCount("surround", 2, 2));
});

test("decodePcm16 reads L16 big endian signed", () => {
	const b = Buffer.alloc(12 + 4);
	b.writeInt16BE(-2, 12);
	b.writeInt16BE(32767, 14);
	const out = m.decodePcm16(b, 12, 1, 2, 2);
	assert.deepStrictEqual(Array.from(out), [-2, 32767]);
});

test("decodePcm16 keeps the upper 16 bits of L24", () => {
	const b = Buffer.alloc(12 + 6);
	b.writeIntBE(0x123456, 12, 3);
	b.writeIntBE(-0x000100, 15, 3);
	const out = m.decodePcm16(b, 12, 1, 2, 3);
	assert.deepStrictEqual(Array.from(out), [0x1234, -1]);
});

test("decodePcm16 rejects short packets and bad sample sizes", () => {
	assert.throws(() => m.decodePcm16(Buffer.alloc(14), 12, 1, 2, 2), RangeError);
	assert.throws(() => m.decodePcm16(Buffer.alloc(40), 12, 1, 2, 4));
});

test("mapChannels maps in order, drops extra, pads missing", () => {
	const src = Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8]); // 2 frames x 4 ch
	assert.deepStrictEqual(Array.from(m.mapChannels(src, 4, 2)), [1, 2, 5, 6]);
	assert.deepStrictEqual(
		Array.from(m.mapChannels(src, 4, 6)),
		[1, 2, 3, 4, 0, 0, 5, 6, 7, 8, 0, 0]
	);
});

test("mixdown sums all channels onto every output channel", () => {
	const src = Int16Array.from([1, 2, 3, 10, 20, 30]); // 2 frames x 3 ch
	assert.deepStrictEqual(Array.from(m.mixdown(src, 3, 2)), [6, 6, 60, 60]);
	assert.deepStrictEqual(Array.from(m.mixdown(src, 3, 1)), [6, 60]);
});

test("mixdown limits to the Int16 range and supports gain", () => {
	const src = Int16Array.from([30000, 30000, -30000, -30000]);
	assert.deepStrictEqual(Array.from(m.mixdown(src, 2, 1)), [32767, -32768]);
	assert.deepStrictEqual(
		Array.from(m.mixdown(src, 2, 1, 0.5)),
		[30000, -30000]
	);
});

test("mapChannels and mixdown reject partial frames and bad channel counts", () => {
	const partial = Int16Array.from([1, 2, 3]);
	for (const fn of [m.mapChannels, m.mixdown]) {
		assert.throws(() => fn(partial, 2, 2), RangeError);
		assert.throws(() => fn(partial, 0, 2), RangeError);
		assert.throws(() => fn(partial, 1.5, 2), RangeError);
		assert.throws(() => fn(partial, 3, 0), RangeError);
		assert.strictEqual(fn(new Int16Array(0), 2, 2).length, 0);
	}
});
