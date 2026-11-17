const test = require("node:test");
const assert = require("node:assert");
const { rtpHeaderLength } = require("../src/lib/rtp.js");

test("plain header is 12 bytes", () => {
	assert.strictEqual(rtpHeaderLength(Buffer.alloc(20)), 12);
});

test("CSRC count adds 4 bytes each", () => {
	const b = Buffer.alloc(30);
	b[0] = 0x02;
	assert.strictEqual(rtpHeaderLength(b), 20);
});

test("extension adds 4 + 4*length bytes", () => {
	const b = Buffer.alloc(40);
	b[0] = 0x10;
	b.writeUInt16BE(2, 14);
	assert.strictEqual(rtpHeaderLength(b), 12 + 4 + 8);
});

test("too short packets return -1", () => {
	assert.strictEqual(rtpHeaderLength(Buffer.alloc(5)), -1);
	const csrc = Buffer.alloc(14);
	csrc[0] = 0x0f;
	assert.strictEqual(rtpHeaderLength(csrc), -1);
	const ext = Buffer.alloc(14);
	ext[0] = 0x10;
	assert.strictEqual(rtpHeaderLength(ext), -1);
	const extLong = Buffer.alloc(20);
	extLong[0] = 0x10;
	extLong.writeUInt16BE(100, 14);
	assert.strictEqual(rtpHeaderLength(extLong), -1);
	assert.strictEqual(rtpHeaderLength(null), -1);
});
