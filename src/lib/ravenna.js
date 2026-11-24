/**
 * RAVENNA / AES67 session discovery over Bonjour (mDNS) + RTSP.
 *
 * Some devices (Merging Horus, Anubis, ...) do not send SAP. They advertise each
 * stream as a DNS-SD service of type _rtsp._tcp (RAVENNA sessions use the subtype
 * _ravenna_session._sub._rtsp._tcp) and hand out the SDP over RTSP:
 *
 *   mDNS PTR  _rtsp._tcp.local        -> "<session name>._rtsp._tcp.local"
 *   mDNS SRV  "<session name>..."     -> host name + port (e.g. 9090)
 *   mDNS A    host name               -> IPv4 address
 *   RTSP      DESCRIBE rtsp://<host>:<port>/by-name/<session name>  -> SDP body
 *
 * The request format was checked by hand on the user's Mac (2026-11-24, see
 * docs/ROADMAP.md): "DESCRIBE rtsp://Isstudio1-2.local:9090/by-name/<name>
 * RTSP/1.0" answered "200 OK" with a "content-type: application/sdp" body in the
 * same format SAP carries. RTSP request/response framing is RFC 2326 §6-7
 * (start line, CRLF separated headers, blank line, optional Content-Length body);
 * mDNS / DNS-SD are RFC 6762 / RFC 6763. These RFC section numbers come from my own
 * knowledge and were not re-checked against the documents.
 *
 * The code is split so that most of it needs no network in tests:
 *  - buildDescribeRequest / RtspResponseParser / describe: RTSP client.
 *  - ServiceTracker: turns DNS records into "resolved" / "gone" events.
 *  - start(): wires an mDNS socket, the tracker, a bounded DESCRIBE queue and
 *    periodic refresh; mDNS socket and DESCRIBE function can be injected.
 */
const net = require("net");

const SESSION_SERVICES = [
	"_ravenna_session._sub._rtsp._tcp.local",
	"_rtsp._tcp.local",
];
const SERVICE_SUFFIX = "._rtsp._tcp.local";

const MAX_RESPONSE_BYTES = 64 * 1024;
const DESCRIBE_TIMEOUT_MS = 5000;
const MAX_PARALLEL_DESCRIBE = 4;
const REFRESH_INTERVAL_MS = 60 * 1000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Builds the RTSP DESCRIBE request for one session.
 * @param {string} target - host name from the SRV record (as used in the URL).
 * @param {number} port
 * @param {string} instance - session (service instance) name.
 * @returns {string}
 */
function buildDescribeRequest(target, port, instance) {
	const host = String(target).replace(/\.$/, "");
	// encodeURIComponent leaves ! ' ( ) * alone; session names often contain
	// parentheses, so encode those too (a server decodes %xx either way).
	const name = encodeURIComponent(instance).replace(
		/[!'()*]/g,
		(c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
	);
	const url = "rtsp://" + host + ":" + port + "/by-name/" + name;
	return (
		"DESCRIBE " +
		url +
		" RTSP/1.0\r\n" +
		"CSeq: 1\r\n" +
		"Accept: application/sdp\r\n" +
		"User-Agent: aes67-monitor\r\n" +
		"\r\n"
	);
}

/**
 * Incremental parser for one RTSP response (status line, headers, body of
 * Content-Length bytes). feed() returns null until the response is complete.
 * Throws if the response is malformed or larger than MAX_RESPONSE_BYTES.
 */
class RtspResponseParser {
	constructor(maxBytes = MAX_RESPONSE_BYTES) {
		this.maxBytes = maxBytes;
		this.chunks = [];
		this.size = 0;
		this.head = null;
	}

	feed(chunk) {
		this.size += chunk.length;
		if (this.size > this.maxBytes) {
			throw new Error("RTSP response too large");
		}
		this.chunks.push(chunk);
		const data = Buffer.concat(this.chunks);
		this.chunks = [data];

		if (!this.head) {
			const end = data.indexOf("\r\n\r\n");
			if (end === -1) {
				return null;
			}
			const lines = data.toString("latin1", 0, end).split("\r\n");
			const match = /^RTSP\/\d+\.\d+ (\d{3})(?: (.*))?$/.exec(lines[0]);
			if (!match) {
				throw new Error("Invalid RTSP status line");
			}
			const headers = {};
			for (let i = 1; i < lines.length; i++) {
				const colon = lines[i].indexOf(":");
				if (colon > 0) {
					headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i]
						.slice(colon + 1)
						.trim();
				}
			}
			let length = 0;
			if (headers["content-length"] !== undefined) {
				if (!/^\d+$/.test(headers["content-length"])) {
					throw new Error("Invalid Content-Length");
				}
				length = parseInt(headers["content-length"], 10);
				if (length > this.maxBytes) {
					throw new Error("RTSP response too large");
				}
			}
			this.head = {
				status: parseInt(match[1], 10),
				reason: match[2] || "",
				headers,
				length,
				bodyStart: end + 4,
			};
		}

		const { bodyStart, length } = this.head;
		if (data.length - bodyStart < length) {
			return null;
		}
		return {
			status: this.head.status,
			reason: this.head.reason,
			headers: this.head.headers,
			body: data.toString("utf8", bodyStart, bodyStart + length),
		};
	}
}

/**
 * Fetches the SDP of one session with RTSP DESCRIBE.
 * Connects to `ip` (so no name lookup is needed) but uses `target` in the URL
 * like the manually tested request.
 * @returns {Promise<string>} the SDP text; rejects on timeout, non-200 status or
 *   a body that is not SDP.
 */
function describe({
	ip,
	port,
	target,
	instance,
	timeoutMs = DESCRIBE_TIMEOUT_MS,
}) {
	return new Promise((resolve, reject) => {
		const parser = new RtspResponseParser();
		const socket = net.connect({ host: ip, port });
		let finished = false;

		const finish = (error, sdp) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(sdp);
		};

		const timer = setTimeout(
			() => finish(new Error("RTSP DESCRIBE timeout")),
			timeoutMs
		);

		socket.on("connect", () => {
			socket.write(buildDescribeRequest(target, port, instance));
		});
		socket.on("data", (chunk) => {
			try {
				const response = parser.feed(chunk);
				if (!response) return;
				if (response.status !== 200) {
					finish(new Error("RTSP status " + response.status));
					return;
				}
				const type = response.headers["content-type"] || "";
				if (!/application\/sdp/i.test(type) || !response.body) {
					finish(new Error("RTSP response is not SDP"));
					return;
				}
				finish(null, response.body);
			} catch (error) {
				finish(error);
			}
		});
		socket.on("error", (error) => finish(error));
		socket.on("close", () => finish(new Error("RTSP connection closed")));
	});
}

/**
 * Session name from a service instance full name:
 * "Foo Bar-1._rtsp._tcp.local" -> "Foo Bar-1". null if it is not an _rtsp._tcp
 * instance.
 */
function instanceName(fullName) {
	const lower = fullName.toLowerCase();
	if (
		!lower.endsWith(SERVICE_SUFFIX) ||
		fullName.length === SERVICE_SUFFIX.length
	) {
		return null;
	}
	return fullName.slice(0, fullName.length - SERVICE_SUFFIX.length);
}

/**
 * Collects PTR / SRV / A records into resolved sessions.
 * process(records) returns { resolved, gone, queries }:
 *  - resolved: sessions that now have a name, host, port and IPv4 address (once
 *    per change of host/port/address).
 *  - gone: sessions whose PTR record was withdrawn (TTL 0, "goodbye").
 *  - queries: DNS questions to send to find the missing SRV / A records.
 */
class ServiceTracker {
	constructor() {
		this.instances = new Map(); // full name -> { name, announced }
		this.srv = new Map(); // full name (lowercase) -> { target, port }
		this.addresses = new Map(); // host (lowercase) -> ipv4
		this.emitted = new Map(); // full name -> "ip|port|target"
	}

	process(records) {
		const resolved = [];
		const gone = [];
		const queries = [];
		const touched = new Set();

		for (const r of records) {
			if (!r || typeof r.name !== "string") continue;
			const name = r.name;
			const key = name.toLowerCase();

			if (r.type === "PTR" && typeof r.data === "string") {
				const service = key.replace(/\.$/, "");
				if (!SESSION_SERVICES.includes(service)) continue;
				const instance = instanceName(r.data);
				if (instance === null) continue;
				const fullKey = r.data.toLowerCase();
				if (r.ttl === 0) {
					if (this.instances.delete(fullKey)) {
						this.emitted.delete(fullKey);
						gone.push({ instance });
					}
				} else {
					if (!this.instances.has(fullKey)) {
						this.instances.set(fullKey, { name: instance, fullName: r.data });
					}
					touched.add(fullKey);
				}
			} else if (
				r.type === "SRV" &&
				r.data &&
				typeof r.data.target === "string"
			) {
				if (r.ttl === 0) continue;
				this.srv.set(key, { target: r.data.target, port: r.data.port });
				touched.add(key);
			} else if (r.type === "A" && typeof r.data === "string") {
				if (r.ttl === 0) continue;
				this.addresses.set(key, r.data);
				for (const [fullKey, srv] of this.srv) {
					if (srv.target.toLowerCase() === key) touched.add(fullKey);
				}
			}
		}

		// Try every instance that was touched, and ask for what is still missing.
		for (const fullKey of touched) {
			const inst = this.instances.get(fullKey);
			if (!inst) continue;
			const srv = this.srv.get(fullKey);
			if (!srv) {
				queries.push({ name: inst.fullName, type: "SRV" });
				continue;
			}
			const ip = this.addresses.get(srv.target.toLowerCase());
			if (!ip) {
				queries.push({ name: srv.target, type: "A" });
				continue;
			}
			const signature = ip + "|" + srv.port + "|" + srv.target;
			if (this.emitted.get(fullKey) !== signature) {
				this.emitted.set(fullKey, signature);
				resolved.push({
					instance: inst.name,
					target: srv.target,
					port: srv.port,
					ip,
				});
			}
		}

		return { resolved, gone, queries };
	}

	/** All sessions that are currently resolved (for the periodic refresh). */
	known() {
		const out = [];
		for (const [fullKey, inst] of this.instances) {
			const srv = this.srv.get(fullKey);
			const ip = srv && this.addresses.get(srv.target.toLowerCase());
			if (srv && ip) {
				out.push({
					instance: inst.name,
					target: srv.target,
					port: srv.port,
					ip,
				});
			}
		}
		return out;
	}
}

/**
 * Starts discovery on one network interface.
 * @param {Object} options
 * @param {string} options.interfaceAddress - IPv4 address of the interface.
 * @param {function(string, string)} options.onSdp - (rawSdp, instance) for every
 *   SDP received (also on refresh).
 * @param {function(string)} options.onGone - (instance) when a session's
 *   announcement was withdrawn.
 * @param {function} [options.mdnsFactory] - (opts) => mDNS socket (default
 *   multicast-dns); injectable for tests.
 * @param {function} [options.describeFn] - default describe(); injectable.
 * @param {number} [options.refreshMs]
 * @returns {{stop: function}}
 */
function start({
	interfaceAddress,
	onSdp,
	onGone,
	mdnsFactory,
	describeFn = describe,
	refreshMs = REFRESH_INTERVAL_MS,
}) {
	const factory = mdnsFactory || require("multicast-dns");
	const tracker = new ServiceTracker();
	const failedUntil = new Map(); // instance -> timestamp
	const inFlight = new Set();
	const queue = [];
	let running = 0;
	let stopped = false;

	// bind: "0.0.0.0": a socket bound to the interface's unicast address would not
	// receive datagrams addressed to the multicast group (224.0.0.251); `interface`
	// still limits the multicast membership and sending to the chosen interface.
	const mdns = factory({
		interface: interfaceAddress,
		bind: "0.0.0.0",
		reuseAddr: true,
	});
	mdns.on("error", (error) => {
		console.error("[RAVENNA mDNS ERROR]", error.message);
	});

	const query = (questions) => {
		if (stopped || questions.length === 0) return;
		try {
			mdns.query({ questions });
		} catch (error) {
			console.error("[RAVENNA] mDNS query failed:", error.message);
		}
	};

	const askForSessions = () =>
		query(SESSION_SERVICES.map((name) => ({ name, type: "PTR" })));

	const pump = () => {
		while (!stopped && running < MAX_PARALLEL_DESCRIBE && queue.length > 0) {
			const job = queue.shift();
			running++;
			describeFn(job)
				.then((sdp) => {
					failedUntil.delete(job.instance);
					if (!stopped) onSdp(sdp, job.instance);
				})
				.catch((error) => {
					failedUntil.set(job.instance, Date.now() + FAILURE_BACKOFF_MS);
					console.log(
						"[RAVENNA] DESCRIBE failed for " +
							job.instance +
							": " +
							error.message
					);
				})
				.then(() => {
					running--;
					inFlight.delete(job.instance);
					pump();
				});
		}
	};

	const enqueue = (job) => {
		if (inFlight.has(job.instance)) return;
		const until = failedUntil.get(job.instance);
		if (until && until > Date.now()) return;
		inFlight.add(job.instance);
		queue.push(job);
		pump();
	};

	mdns.on("response", (packet) => {
		if (stopped) return;
		const records = (packet.answers || []).concat(packet.additionals || []);
		const { resolved, gone, queries } = tracker.process(records);
		for (const g of gone) onGone(g.instance);
		for (const job of resolved) enqueue(job);
		query(queries);
	});

	askForSessions();
	const timer = setInterval(() => {
		askForSessions();
		for (const job of tracker.known()) enqueue(job);
	}, refreshMs);

	return {
		stop() {
			stopped = true;
			clearInterval(timer);
			queue.length = 0;
			try {
				mdns.destroy();
			} catch (error) {
				// already closed
			}
		},
	};
}

module.exports = {
	SESSION_SERVICES,
	buildDescribeRequest,
	RtspResponseParser,
	describe,
	instanceName,
	ServiceTracker,
	start,
};
