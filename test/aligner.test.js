const test = require("node:test");
const assert = require("node:assert");
const { PacketAligner } = require("../src/lib/aligner.js");

test("pairs packets with equal timestamps regardless of arrival order", () => {
	const a = new PacketAligner(2, 48);
	a.push(0, 1000, "a0");
	assert.strictEqual(a.pop(), null); // waits for member 1
	a.push(1, 1000, "b0");
	a.push(1, 1048, "b1");
	assert.deepStrictEqual(a.pop(), ["a0", "b0"]);
	assert.strictEqual(a.pop(), null);
	a.push(0, 1048, "a1");
	assert.deepStrictEqual(a.pop(), ["a1", "b1"]);
	assert.strictEqual(a.mode, "timestamp");
});

test("starts at the oldest head and drops late packets", () => {
	const a = new PacketAligner(2, 48);
	a.push(1, 1048, "b1");
	a.push(0, 1000, "a0");
	a.push(0, 1048, "a1");
	// cursor = 1000: member 1 has no packet 1000 -> silence for it
	assert.deepStrictEqual(a.pop(), ["a0", null]);
	assert.deepStrictEqual(a.pop(), ["a1", "b1"]);
	a.push(1, 1048, "late");
	a.push(0, 1096, "a2");
	a.push(1, 1096, "b2");
	assert.deepStrictEqual(a.pop(), ["a2", "b2"]);
	assert.strictEqual(a.dropped, 1);
	assert.strictEqual(a.missing, 1);
});

test("lost packet of one member becomes silence after maxWait", () => {
	const a = new PacketAligner(2, 48, { maxWait: 3 });
	a.push(0, 0, "a0");
	a.push(1, 0, "b0");
	assert.deepStrictEqual(a.pop(), ["a0", "b0"]);
	a.push(0, 48, "a1");
	a.push(0, 96, "a2");
	assert.strictEqual(a.pop(), null);
	a.push(0, 144, "a3");
	assert.deepStrictEqual(a.pop(), ["a1", null]);
});

test("timestamp wrap at 2^32", () => {
	const a = new PacketAligner(2, 48);
	const t = 4294967280; // 2^32 - 16
	a.push(0, t, "a0");
	a.push(1, t, "b0");
	a.push(0, (t + 48) >>> 0, "a1");
	a.push(1, (t + 48) >>> 0, "b1");
	assert.deepStrictEqual(a.pop(), ["a0", "b0"]);
	assert.deepStrictEqual(a.pop(), ["a1", "b1"]);
});

test("different timestamp bases fall back to arrival order", () => {
	const a = new PacketAligner(2, 48, { maxDepth: 8 });
	const frames = [];
	for (let i = 0; i < 20; i++) {
		a.push(0, i * 48, "a" + i);
		a.push(1, 900000 + i * 48, "b" + i);
		let f;
		while ((f = a.pop()) !== null) frames.push(f);
	}
	assert.strictEqual(a.mode, "arrival");
	const last = frames[frames.length - 1];
	assert.deepStrictEqual(last, ["a19", "b19"]);
});

test("arrival mode caps queue depth", () => {
	const a = new PacketAligner(2, 48, { maxDepth: 4 });
	a.mode = "arrival";
	for (let i = 0; i < 10; i++) a.push(0, 0, i);
	assert.strictEqual(a.queues[0].length, 4);
	assert.strictEqual(a.dropped, 6);
});

test("arrival mode silences a member that stopped sending", () => {
	const a = new PacketAligner(2, 48, { maxWait: 2 });
	a.mode = "arrival";
	a.push(0, 0, "a0");
	assert.strictEqual(a.pop(), null);
	a.push(0, 0, "a1");
	assert.deepStrictEqual(a.pop(), ["a0", null]);
});

test("timestamp offset that is not a whole packet falls back to arrival", () => {
	const a = new PacketAligner(2, 48);
	const frames = [];
	for (let i = 0; i < 20; i++) {
		a.push(0, i * 48, "a" + i);
		a.push(1, i * 48 + 1, "b" + i);
		let f;
		while ((f = a.pop()) !== null) frames.push(f);
	}
	assert.strictEqual(a.mode, "arrival");
	// member 1 is not lost: every later frame has both members
	assert.deepStrictEqual(frames[frames.length - 1], ["a19", "b19"]);
	assert.ok(frames.filter((f) => f[1] !== null).length >= 18);
});

test("reordered packets inside the playout window are not dropped", () => {
	const a = new PacketAligner(2, 48);
	const frames = [];
	const feed = (ts) => {
		a.push(0, ts, "a" + ts);
		a.push(1, ts, "b" + ts);
		let f;
		while ((f = a.pop()) !== null) frames.push(f);
	};
	feed(0);
	feed(96);
	feed(48);
	feed(144);
	assert.deepStrictEqual(frames, [
		["a0", "b0"],
		["a48", "b48"],
		["a96", "b96"],
		["a144", "b144"],
	]);
	assert.strictEqual(a.dropped, 0);
});

test("a packet lost on every member becomes one silent frame", () => {
	const a = new PacketAligner(2, 48, { maxWait: 2 });
	const frames = [];
	for (const ts of [0, 96, 144, 192]) {
		a.push(0, ts, "a" + ts);
		a.push(1, ts, "b" + ts);
		let f;
		while ((f = a.pop()) !== null) frames.push(f);
	}
	assert.deepStrictEqual(frames.slice(0, 3), [
		["a0", "b0"],
		[null, null],
		["a96", "b96"],
	]);
});

test("a long gap resyncs instead of emitting a burst of silence", () => {
	const a = new PacketAligner(2, 48, { maxWait: 2, maxDepth: 8 });
	const frames = [];
	for (const ts of [0, 48000, 48048, 48096]) {
		a.push(0, ts, "a" + ts);
		a.push(1, ts, "b" + ts);
		let f;
		while ((f = a.pop()) !== null) frames.push(f);
	}
	assert.deepStrictEqual(frames.slice(0, 2), [
		["a0", "b0"],
		["a48000", "b48000"],
	]);
	assert.strictEqual(a.mode, "timestamp");
});

test("duplicate packet is ignored", () => {
	const a = new PacketAligner(1, 48);
	a.push(0, 0, "x");
	a.push(0, 0, "dup");
	assert.strictEqual(a.queues[0].length, 1);
	assert.strictEqual(a.dropped, 1);
});
