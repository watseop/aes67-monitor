const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const EventEmitter = require("events");
const {
	buildDescribeRequest,
	RtspResponseParser,
	describe,
	instanceName,
	ServiceTracker,
	start,
} = require("../src/lib/ravenna.js");

const SDP = "v=0\r\no=- 24 0 IN IP4 172.16.0.72\r\ns=Test\r\n";

function rtspOk(body, extra = "") {
	return (
		"RTSP/1.0 200 OK\r\nCSeq: 1\r\ncontent-type: application/sdp\r\n" +
		extra +
		"Content-Length: " +
		Buffer.byteLength(body) +
		"\r\n\r\n" +
		body
	);
}

async function waitFor(fn, ms = 2000) {
	const t0 = Date.now();
	while (!fn()) {
		if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
		await new Promise((r) => setTimeout(r, 5));
	}
}

test("buildDescribeRequest uses the manually tested format and encodes the name", () => {
	const req = buildDescribeRequest(
		"Isstudio1-2.local.",
		9090,
		"CoreAudio (on X)_Audio Device-1"
	);
	assert.ok(
		req.startsWith(
			"DESCRIBE rtsp://Isstudio1-2.local:9090/by-name/" +
				"CoreAudio%20%28on%20X%29_Audio%20Device-1 RTSP/1.0\r\n"
		)
	);
	assert.ok(req.includes("\r\nCSeq: 1\r\n"));
	assert.ok(req.includes("\r\nAccept: application/sdp\r\n"));
	assert.ok(req.endsWith("\r\n\r\n"));
});

test("RtspResponseParser parses a response in one chunk and in pieces", () => {
	const raw = Buffer.from(rtspOk(SDP));
	const one = new RtspResponseParser().feed(raw);
	assert.strictEqual(one.status, 200);
	assert.strictEqual(one.headers["content-type"], "application/sdp");
	assert.strictEqual(one.body, SDP);

	const parser = new RtspResponseParser();
	let result = null;
	for (let i = 0; i < raw.length; i += 7) {
		result = parser.feed(raw.subarray(i, i + 7));
		if (i + 7 < raw.length) assert.strictEqual(result, null);
	}
	assert.strictEqual(result.body, SDP);
});

test("RtspResponseParser reports non-200 status and header case", () => {
	const r = new RtspResponseParser().feed(
		Buffer.from("RTSP/1.0 404 Not Found\r\nCONTENT-LENGTH: 0\r\n\r\n")
	);
	assert.strictEqual(r.status, 404);
	assert.strictEqual(r.reason, "Not Found");
	assert.strictEqual(r.body, "");
});

test("RtspResponseParser rejects malformed and oversized responses", () => {
	assert.throws(() =>
		new RtspResponseParser().feed(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"))
	);
	assert.throws(() =>
		new RtspResponseParser().feed(
			Buffer.from("RTSP/1.0 200 OK\r\nContent-Length: abc\r\n\r\n")
		)
	);
	assert.throws(() =>
		new RtspResponseParser(100).feed(
			Buffer.from("RTSP/1.0 200 OK\r\nContent-Length: 5000\r\n\r\n")
		)
	);
	assert.throws(() => new RtspResponseParser(10).feed(Buffer.alloc(11)));
});

function rtspServer(handler) {
	return new Promise((resolve) => {
		const requests = [];
		const server = net.createServer((socket) => {
			socket.on("data", (d) => {
				requests.push(d.toString());
				handler(socket);
			});
			socket.on("error", () => {});
		});
		server.listen(0, "127.0.0.1", () =>
			resolve({ server, port: server.address().port, requests })
		);
	});
}

test("describe returns the SDP of a 200 response", async () => {
	const s = await rtspServer((socket) => socket.end(rtspOk(SDP)));
	try {
		const sdp = await describe({
			ip: "127.0.0.1",
			port: s.port,
			target: "host.local.",
			instance: "My Session",
		});
		assert.strictEqual(sdp, SDP);
		assert.ok(
			s.requests[0].startsWith(
				"DESCRIBE rtsp://host.local:" +
					s.port +
					"/by-name/My%20Session RTSP/1.0"
			)
		);
	} finally {
		s.server.close();
	}
});

test("describe rejects on 404, non-SDP body, timeout and refused connection", async () => {
	const args = (port) => ({
		ip: "127.0.0.1",
		port,
		target: "h",
		instance: "x",
		timeoutMs: 150,
	});

	let s = await rtspServer((socket) =>
		socket.end("RTSP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n")
	);
	await assert.rejects(describe(args(s.port)), /status 404/);
	s.server.close();

	s = await rtspServer((socket) =>
		socket.end(
			"RTSP/1.0 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nhi"
		)
	);
	await assert.rejects(describe(args(s.port)), /not SDP/);
	s.server.close();

	s = await rtspServer(() => {}); // never answers
	await assert.rejects(describe(args(s.port)), /timeout/);
	s.server.close();

	const free = await new Promise((resolve) => {
		const srv = net.createServer().listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
	});
	await assert.rejects(describe(args(free)));
});

test("instanceName strips the service suffix", () => {
	assert.strictEqual(
		instanceName("Foo (on Bar)_Baz-1._rtsp._tcp.local"),
		"Foo (on Bar)_Baz-1"
	);
	assert.strictEqual(instanceName("x._http._tcp.local"), null);
	assert.strictEqual(instanceName("._rtsp._tcp.local"), null);
});

const SESSIONS = "_ravenna_session._sub._rtsp._tcp.local";
const FULL = "Dev Stream-1._rtsp._tcp.local";
const ptr = (data = FULL, ttl = 120, name = SESSIONS) => ({
	name,
	type: "PTR",
	ttl,
	data,
});
const srv = (target = "dev.local", port = 9090, name = FULL) => ({
	name,
	type: "SRV",
	ttl: 120,
	data: { priority: 0, weight: 0, port, target },
});
const addr = (ip = "10.0.0.5", name = "dev.local") => ({
	name,
	type: "A",
	ttl: 120,
	data: ip,
});

test("ServiceTracker resolves PTR + SRV + A from one packet", () => {
	const t = new ServiceTracker();
	const r = t.process([ptr(), srv(), addr()]);
	assert.deepStrictEqual(r.resolved, [
		{
			instance: "Dev Stream-1",
			target: "dev.local",
			port: 9090,
			ip: "10.0.0.5",
		},
	]);
	assert.deepStrictEqual(r.queries, []);
	assert.strictEqual(t.known().length, 1);
});

test("ServiceTracker asks for missing SRV and A records, then resolves", () => {
	const t = new ServiceTracker();
	let r = t.process([ptr()]);
	assert.deepStrictEqual(r.queries, [{ name: FULL, type: "SRV" }]);
	assert.strictEqual(r.resolved.length, 0);

	r = t.process([srv()]);
	assert.deepStrictEqual(r.queries, [{ name: "dev.local", type: "A" }]);

	r = t.process([addr()]);
	assert.strictEqual(r.resolved.length, 1);
	assert.strictEqual(r.resolved[0].ip, "10.0.0.5");
});

test("ServiceTracker matches names case-insensitively and plain _rtsp._tcp", () => {
	const t = new ServiceTracker();
	const r = t.process([
		ptr(FULL, 120, "_RTSP._tcp.local"),
		{ ...srv("Dev.Local"), name: FULL.toUpperCase() },
		addr("10.0.0.5", "DEV.local"),
	]);
	assert.strictEqual(r.resolved.length, 1);
});

test("ServiceTracker ignores other services and reports each change once", () => {
	const t = new ServiceTracker();
	assert.deepStrictEqual(
		t.process([ptr("x._http._tcp.local", 120, "_http._tcp.local")]).resolved,
		[]
	);
	assert.strictEqual(t.process([ptr(), srv(), addr()]).resolved.length, 1);
	// Same announcement again: nothing new.
	assert.strictEqual(t.process([ptr(), srv(), addr()]).resolved.length, 0);
	// Address change: resolved again.
	assert.strictEqual(t.process([addr("10.0.0.9")]).resolved[0].ip, "10.0.0.9");
});

test("ServiceTracker reports goodbye (TTL 0) once", () => {
	const t = new ServiceTracker();
	t.process([ptr(), srv(), addr()]);
	assert.deepStrictEqual(t.process([ptr(FULL, 0)]).gone, [
		{ instance: "Dev Stream-1" },
	]);
	assert.deepStrictEqual(t.process([ptr(FULL, 0)]).gone, []);
	assert.strictEqual(t.known().length, 0);
});

function fakeMdns() {
	const m = new EventEmitter();
	m.queries = [];
	m.destroyed = false;
	m.query = (q) => m.queries.push(q);
	m.destroy = () => {
		m.destroyed = true;
	};
	return m;
}

function packet(...records) {
	return { answers: records, additionals: [] };
}

test("start() queries, describes a resolved session, refreshes and handles goodbye", async () => {
	const mdns = fakeMdns();
	const described = [];
	const sdps = [];
	const gone = [];
	const handle = start({
		interfaceAddress: "10.0.0.2",
		onSdp: (sdp, instance) => sdps.push([sdp, instance]),
		onGone: (instance) => gone.push(instance),
		mdnsFactory: (opts) => {
			assert.strictEqual(opts.interface, "10.0.0.2");
			assert.strictEqual(opts.bind, "0.0.0.0");
			return mdns;
		},
		describeFn: async (job) => {
			described.push(job);
			return SDP;
		},
		refreshMs: 30,
	});

	assert.deepStrictEqual(
		mdns.queries[0].questions.map((q) => q.name),
		[SESSIONS, "_rtsp._tcp.local"]
	);

	mdns.emit("response", packet(ptr(), srv(), addr()));
	await waitFor(() => sdps.length === 1);
	assert.deepStrictEqual(sdps[0], [SDP, "Dev Stream-1"]);
	assert.strictEqual(described[0].ip, "10.0.0.5");
	assert.strictEqual(described[0].port, 9090);

	// Periodic refresh asks again and describes the known session again.
	await waitFor(() => sdps.length >= 2);
	assert.ok(mdns.queries.length >= 2);

	mdns.emit("response", packet(ptr(FULL, 0)));
	assert.deepStrictEqual(gone, ["Dev Stream-1"]);

	handle.stop();
	assert.strictEqual(mdns.destroyed, true);
	const count = sdps.length;
	await new Promise((r) => setTimeout(r, 80));
	assert.strictEqual(sdps.length, count);
});

test("start() backs off after a failed DESCRIBE and limits parallel requests", async () => {
	const mdns = fakeMdns();
	const calls = {};
	let running = 0;
	let maxRunning = 0;
	const sdps = [];
	const handle = start({
		interfaceAddress: "10.0.0.2",
		onSdp: (sdp, instance) => sdps.push(instance),
		onGone: () => {},
		mdnsFactory: () => mdns,
		describeFn: async (job) => {
			calls[job.instance] = (calls[job.instance] || 0) + 1;
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 20));
			running--;
			if (job.instance === "Bad") throw new Error("404");
			return SDP;
		},
		refreshMs: 25,
	});

	const records = [addr()];
	for (let i = 0; i < 10; i++) {
		const full = "S" + i + "._rtsp._tcp.local";
		records.push(ptr(full), { ...srv(), name: full });
	}
	records.push(ptr("Bad._rtsp._tcp.local"), {
		...srv(),
		name: "Bad._rtsp._tcp.local",
	});
	mdns.emit("response", packet(...records));

	await waitFor(() => sdps.length >= 10);
	assert.ok(maxRunning <= 4, "parallel DESCRIBE limit, saw " + maxRunning);
	await new Promise((r) => setTimeout(r, 150)); // several refresh cycles
	handle.stop();
	// "Bad" failed once and is not retried inside the back-off window, while the
	// working sessions are described again on every refresh.
	assert.ok(!sdps.includes("Bad"));
	assert.strictEqual(calls.Bad, 1);
	assert.ok(calls.S0 > 1, "refresh describes working sessions again");
});

test("ServiceTracker re-asks for SRV / A after their TTL expired", () => {
	let now = 1000;
	const t = new ServiceTracker(() => now);
	assert.strictEqual(t.process([ptr(), srv(), addr()]).resolved.length, 1);

	// SRV (120 s default in these helpers) and A expired, PTR refreshed only.
	now += 121 * 1000;
	let r = t.process([ptr()]);
	assert.deepStrictEqual(r.queries, [{ name: FULL, type: "SRV" }]);
	assert.strictEqual(t.known().length, 0);

	// The device answers with a new port: resolved again with the new endpoint.
	r = t.process([srv("dev.local", 9191), addr()]);
	assert.strictEqual(r.resolved.length, 1);
	assert.strictEqual(r.resolved[0].port, 9191);
});

test("ServiceTracker forgets a withdrawn SRV / A (TTL 0) and sweeps expired PTRs", () => {
	let now = 1000;
	const t = new ServiceTracker(() => now);
	t.process([ptr(), srv(), addr()]);
	t.process([addr("10.0.0.5", "dev.local")].map((a) => ({ ...a, ttl: 0 })));
	assert.strictEqual(t.known().length, 0);
	assert.deepStrictEqual(t.process([ptr()]).queries, [
		{ name: "dev.local", type: "A" },
	]);

	now += 121 * 1000;
	assert.deepStrictEqual(t.sweep(), [{ instance: "Dev Stream-1" }]);
	assert.deepStrictEqual(t.sweep(), []);
});

test("start() discards a DESCRIBE that finishes after the goodbye", async () => {
	const mdns = fakeMdns();
	const sdps = [];
	const gone = [];
	let release;
	let calls = 0;
	const handle = start({
		interfaceAddress: "10.0.0.2",
		onSdp: (sdp, instance) => sdps.push(instance),
		onGone: (instance) => gone.push(instance),
		mdnsFactory: () => mdns,
		describeFn: () => {
			calls++;
			if (calls === 1) {
				return new Promise((resolve) => {
					release = () => resolve(SDP);
				});
			}
			return Promise.resolve(SDP);
		},
		refreshMs: 100000,
	});

	mdns.emit("response", packet(ptr(), srv(), addr()));
	await waitFor(() => calls === 1);
	mdns.emit("response", packet(ptr(FULL, 0)));
	assert.deepStrictEqual(gone, ["Dev Stream-1"]);

	release();
	await new Promise((r) => setTimeout(r, 30));
	assert.deepStrictEqual(sdps, []); // late result must not recreate the stream

	// Announced again: a fresh DESCRIBE is allowed and published.
	mdns.emit("response", packet(ptr(), srv(), addr()));
	await waitFor(() => sdps.length === 1);
	handle.stop();
});

test("start() drops a queued DESCRIBE on goodbye", async () => {
	const mdns = fakeMdns();
	const described = [];
	const releases = [];
	const handle = start({
		interfaceAddress: "10.0.0.2",
		onSdp: () => {},
		onGone: () => {},
		mdnsFactory: () => mdns,
		describeFn: (job) => {
			described.push(job.instance);
			return new Promise((resolve) => releases.push(() => resolve(SDP)));
		},
		refreshMs: 100000,
	});
	try {
		// 4 run in parallel; the 5th waits in the queue and is withdrawn.
		for (const n of ["A", "B", "C", "D", "E"]) {
			const full = n + "._rtsp._tcp.local";
			mdns.emit(
				"response",
				packet(ptr(full), srv("dev.local", 9090, full), addr())
			);
		}
		await waitFor(() => described.length === 4);
		mdns.emit("response", packet(ptr("E._rtsp._tcp.local", 0)));
		releases.forEach((r) => r());
		await new Promise((r) => setTimeout(r, 30));
		assert.deepStrictEqual(described.slice().sort(), ["A", "B", "C", "D"]);
	} finally {
		handle.stop();
	}
});
