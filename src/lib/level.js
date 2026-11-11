/**
 * Per-channel peak / RMS level meter for RTP linear PCM payloads.
 *
 * Basis (payload layout, no change to the existing RTP parsing in audio.js):
 * - RFC 3551 §4.1 / §4.5.11: multichannel linear PCM is interleaved sample by
 *   sample (ch0, ch1, ..., chN-1, then the next sample frame), and L16 samples
 *   are signed, in network byte order (big endian).
 * - RFC 3190: L24 is 24-bit signed linear PCM, network byte order.
 * - AES67 uses L16 and L24 payloads in this form.
 *
 * The caller must only push packets whose length was already validated against
 * the SDP (header + samples * channels * bytesPerSample), so reads stay in bounds.
 */

const DB_FLOOR = -120;

class LevelMeter {
	/**
	 * @param {number} channels - channel count from the SDP (a=rtpmap).
	 * @param {number} bytesPerSample - 2 for L16, 3 for L24.
	 */
	constructor(channels, bytesPerSample) {
		if (bytesPerSample !== 2 && bytesPerSample !== 3) {
			throw new Error("Unsupported bytesPerSample: " + bytesPerSample);
		}
		this.channels = channels;
		this.bytesPerSample = bytesPerSample;
		// Full scale: 2^15 for L16, 2^23 for L24.
		this.fullScale = bytesPerSample === 2 ? 32768 : 8388608;
		this.peak = new Float64Array(channels);
		this.sumSq = new Float64Array(channels);
		this.frames = 0;
		this.packets = 0;
	}

	/**
	 * Accumulates one packet's payload.
	 * @param {Buffer} buffer - the whole RTP packet.
	 * @param {number} headerLength - RTP header length (incl. CSRC / extension).
	 * @param {number} frames - sample frames in this packet (samplesPerPacket).
	 */
	push(buffer, headerLength, frames) {
		const ch = this.channels;
		const bps = this.bytesPerSample;
		const end = headerLength + frames * ch * bps;
		// Defensive: never read past the buffer, even if the caller was wrong.
		if (end > buffer.length) {
			return;
		}

		let pos = headerLength;
		for (let f = 0; f < frames; f++) {
			for (let c = 0; c < ch; c++) {
				const v =
					bps === 2 ? buffer.readInt16BE(pos) : buffer.readIntBE(pos, 3);
				const a = v < 0 ? -v : v;
				if (a > this.peak[c]) {
					this.peak[c] = a;
				}
				this.sumSq[c] += v * v;
				pos += bps;
			}
		}
		this.frames += frames;
		this.packets++;
	}

	/**
	 * Returns levels since the last call in dBFS and resets the accumulators.
	 * @returns {{active: boolean, peak: number[], rms: number[]}}
	 */
	snapshot() {
		const peak = [];
		const rms = [];
		const active = this.packets > 0;

		for (let c = 0; c < this.channels; c++) {
			peak.push(toDbfs(this.peak[c] / this.fullScale));
			rms.push(
				this.frames > 0
					? toDbfs(Math.sqrt(this.sumSq[c] / this.frames) / this.fullScale)
					: DB_FLOOR
			);
		}

		this.peak.fill(0);
		this.sumSq.fill(0);
		this.frames = 0;
		this.packets = 0;

		return { active, peak, rms };
	}
}

/**
 * Linear amplitude (0..1, 1 = full scale) to dBFS, clamped to DB_FLOOR.
 * Clamping avoids -Infinity, which JSON turns into null over IPC.
 */
function toDbfs(linear) {
	if (linear <= 0) {
		return DB_FLOOR;
	}
	const db = 20 * Math.log10(linear);
	return db < DB_FLOOR ? DB_FLOOR : db;
}

module.exports = { LevelMeter, toDbfs, DB_FLOOR };
