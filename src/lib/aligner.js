/**
 * Aligns the packets of several RTP streams (the members of a group) so one
 * output frame contains the same instant of every member.
 *
 * Basis: RFC 3550 §5.1: the RTP timestamp is the sampling instant of the first
 * sample in the packet, in sample clock units (here the sample rate, AES67
 * §7.2). Streams of one source normally share a timestamp base, so packets with
 * the same timestamp belong together. AES67 allows each stream its own clock
 * offset (a=mediaclk:direct=<offset>), so alignment by timestamp can never
 * match; then the aligner falls back to arrival order (one packet from each
 * member per output frame), which is only as exact as the arrival timing.
 * Timestamps wrap at 2^32; comparisons use signed 32-bit differences.
 */

const diff32 = (a, b) => (a - b) | 0;

class PacketAligner {
	/**
	 * @param {number} members - number of streams.
	 * @param {number} step - samples per packet (timestamp increment).
	 * @param {Object} [opts]
	 * @param {number} [opts.maxWait=4] - queued packets in one member after
	 *   which the others are treated as lost instead of waiting for them.
	 * @param {number} [opts.maxDepth=32] - queue depth that triggers the arrival
	 *   fallback (timestamp mode) or drops the oldest packet (arrival mode).
	 */
	constructor(members, step, opts) {
		const o = Object.assign({ maxWait: 4, maxDepth: 32 }, opts);
		this.n = members;
		this.step = step;
		this.maxWait = o.maxWait;
		this.maxDepth = o.maxDepth;
		this.queues = Array.from({ length: members }, () => []);
		this.mode = "timestamp"; // or "arrival"
		this.next = null; // next expected timestamp
		this.dropped = 0; // late or overflowing packets
		this.missing = 0; // member packets replaced by silence
	}

	push(member, timestamp, data) {
		const q = this.queues[member];
		const ts = timestamp >>> 0;
		if (this.mode === "arrival") {
			q.push({ ts, data });
		} else {
			// RFC 3550 §5.1 / §6.4: packets may be reordered in the network, so the
			// queue is kept in timestamp order (insert from the end, usually O(1)).
			let i = q.length;
			while (i > 0 && diff32(q[i - 1].ts, ts) > 0) i--;
			if (i > 0 && q[i - 1].ts === ts) {
				this.dropped++; // duplicate
				return;
			}
			q.splice(i, 0, { ts, data });
		}
		if (q.length > this.maxDepth) {
			if (this.mode === "timestamp") {
				this._toArrival();
			} else {
				q.shift();
				this.dropped++;
			}
		}
	}

	_toArrival() {
		this.mode = "arrival";
		// Keep the newest packets, the same count from every member.
		const keep = Math.min(...this.queues.map((q) => q.length));
		for (const q of this.queues) {
			this.dropped += q.length - keep;
			q.splice(0, q.length - keep);
		}
	}

	/**
	 * Returns the next frame set: an array with one entry per member (data, or
	 * null where the member's packet is missing), or null if more packets are
	 * needed first.
	 */
	pop() {
		const qs = this.queues;
		const deepest = Math.max(...qs.map((q) => q.length));
		if (this.mode === "arrival") {
			// A member that stopped sending is silenced instead of stalling the rest.
			if (qs.some((q) => q.length === 0) && deepest < this.maxWait) return null;
			if (deepest === 0) return null;
			return qs.map((q) => {
				if (q.length > 0) return q.shift().data;
				this.missing++;
				return null;
			});
		}

		if (this.next === null) {
			const heads = qs.filter((q) => q.length > 0).map((q) => q[0].ts);
			if (heads.length < this.n && deepest < this.maxWait) return null;
			if (heads.length === 0) return null;
			this.next = heads.reduce((a, b) => (diff32(b, a) < 0 ? b : a));
		}

		// Late packets (older than the cursor) can no longer be played.
		for (const q of qs) {
			while (q.length > 0 && diff32(q[0].ts, this.next) < 0) {
				q.shift();
				this.dropped++;
			}
		}

		const heads = qs.filter((q) => q.length > 0).map((q) => q[0].ts);
		const hasNext = heads.includes(this.next);
		if (heads.length === this.n) {
			const oldest = heads.reduce((a, b) => (diff32(b, a) < 0 ? b : a));
			const newest = heads.reduce((a, b) => (diff32(b, a) > 0 ? b : a));
			// The members do not share a timestamp base when their heads are
			// further apart than the queue can hold, or when they are not a whole
			// number of packets apart (different clock offsets, AES67 §7.2
			// a=mediaclk:direct): their timestamps can never match.
			const offPhase = heads.some(
				(h) => diff32(h, this.next) % this.step !== 0
			);
			if (diff32(newest, oldest) > this.maxDepth * this.step || offPhase) {
				this._toArrival();
				return this.pop();
			}
		}
		if (!hasNext || heads.length < this.n) {
			// Hold the playout window: a missing packet may still arrive out of
			// order. Wait until one member has maxWait packets queued.
			if (deepest < this.maxWait) return null;
			if (!hasNext) {
				const oldest = heads.reduce((a, b) => (diff32(b, a) < 0 ? b : a));
				if (diff32(oldest, this.next) > this.maxDepth * this.step) {
					// Long gap (source paused / restarted): resync instead of
					// emitting a burst of silent frames.
					this.next = oldest;
				}
				// Otherwise a short gap: the frame below is silence for every
				// member, so the output timeline keeps its length.
			}
		}

		const frame = qs.map((q) => {
			if (q.length > 0 && q[0].ts === this.next) return q.shift().data;
			this.missing++;
			return null;
		});
		this.next = (this.next + this.step) >>> 0;
		return frame;
	}
}

module.exports = { PacketAligner };
