const test = require("node:test");
const assert = require("node:assert");
const { LevelMeter, toDbfs, DB_FLOOR } = require("../src/lib/level.js");

const HEADER = 12;

function packetL16(frames, channels, fn) {
	const buf = Buffer.alloc(HEADER + frames * channels * 2);
	for (let f = 0; f < frames; f++) {
		for (let c = 0; c < channels; c++) {
			buf.writeInt16BE(fn(f, c), HEADER + (f * channels + c) * 2);
		}
	}
	return buf;
}

function packetL24(frames, channels, fn) {
	const buf = Buffer.alloc(HEADER + frames * channels * 3);
	for (let f = 0; f < frames; f++) {
		for (let c = 0; c < channels; c++) {
			buf.writeIntBE(fn(f, c), HEADER + (f * channels + c) * 3, 3);
		}
	}
	return buf;
}

test("silent channel is at the floor, active channel is not (L16, interleaved)", () => {
	const m = new LevelMeter(4, 2);
	// Only channel 2 carries signal.
	m.push(
		packetL16(48, 4, (f, c) => (c === 2 ? 16384 : 0)),
		HEADER,
		48
	);
	const s = m.snapshot();
	assert.strictEqual(s.active, true);
	assert.strictEqual(s.peak[0], DB_FLOOR);
	assert.strictEqual(s.peak[1], DB_FLOOR);
	assert.strictEqual(s.peak[3], DB_FLOOR);
	assert.ok(Math.abs(s.peak[2] - -6.0206) < 0.001); // half scale
	assert.ok(Math.abs(s.rms[2] - -6.0206) < 0.001); // constant DC half scale
});

test("negative full scale L16 reads as 0 dBFS peak", () => {
	const m = new LevelMeter(1, 2);
	m.push(
		packetL16(4, 1, () => -32768),
		HEADER,
		4
	);
	assert.ok(Math.abs(m.snapshot().peak[0]) < 1e-9);
});

test("L24 sign and scale", () => {
	const m = new LevelMeter(2, 3);
	m.push(
		packetL24(8, 2, (f, c) => (c === 0 ? -4194304 : 100)),
		HEADER,
		8
	);
	const s = m.snapshot();
	assert.ok(Math.abs(s.peak[0] - -6.0206) < 0.001);
	assert.ok(s.peak[1] < -90 && s.peak[1] > DB_FLOOR);
});

test("snapshot resets and reports inactive when no packets arrived", () => {
	const m = new LevelMeter(2, 2);
	m.push(
		packetL16(8, 2, () => 1000),
		HEADER,
		8
	);
	assert.strictEqual(m.snapshot().active, true);
	const s = m.snapshot();
	assert.strictEqual(s.active, false);
	assert.deepStrictEqual(s.peak, [DB_FLOOR, DB_FLOOR]);
});

test("packet shorter than declared is ignored, not read out of bounds", () => {
	const m = new LevelMeter(2, 2);
	const short = packetL16(4, 2, () => 1000);
	m.push(short, HEADER, 48);
	assert.strictEqual(m.snapshot().active, false);
});

test("header length (CSRC/extension) offsets the payload", () => {
	const m = new LevelMeter(1, 2);
	const buf = Buffer.alloc(20 + 4 * 2);
	for (let i = 0; i < 4; i++) buf.writeInt16BE(8192, 20 + i * 2);
	m.push(buf, 20, 4);
	assert.ok(Math.abs(m.snapshot().peak[0] - -12.0412) < 0.001);
});

test("toDbfs never returns -Infinity", () => {
	assert.strictEqual(toDbfs(0), DB_FLOOR);
	assert.strictEqual(toDbfs(1e-12), DB_FLOOR);
});
