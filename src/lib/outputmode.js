/**
 * Output mode helpers for multi-channel playback (ROADMAP M2, PR C groundwork).
 * Pure functions, no I/O and no audio device access, so they are unit tested
 * here; wiring them into audio playback is a separate step.
 *
 * Modes (user requirement 2026-11-11):
 *  - "multichannel": source channels are mapped in order to the output channels
 *    (only offered when the device has more than 2 output channels).
 *  - "stereo": two output channels (offered when the device has 2 or more).
 *  - "mono": all source channels are mixed down to one signal that is sent to
 *    both left and right (or to the single output of a 1-channel device).
 * The default is the first mode that is available: multichannel, else stereo,
 * else mono.
 */

const MODES = ["multichannel", "stereo", "mono"];

/**
 * Modes a device with `outputChannels` outputs can offer, best first.
 * @param {number} outputChannels
 * @returns {string[]}
 */
function availableModes(outputChannels) {
	if (!(outputChannels >= 1)) {
		return [];
	}
	if (outputChannels > 2) {
		return ["multichannel", "stereo", "mono"];
	}
	if (outputChannels === 2) {
		return ["stereo", "mono"];
	}
	return ["mono"];
}

/**
 * Mode to use: `requested` if the device offers it, otherwise the default.
 * @returns {string|null} null when the device has no outputs.
 */
function resolveMode(requested, outputChannels) {
	const modes = availableModes(outputChannels);
	if (modes.length === 0) {
		return null;
	}
	return modes.includes(requested) ? requested : modes[0];
}

/**
 * Number of channels to open the output stream with.
 * multichannel: as many as the source has, limited by the device (at least 2).
 * stereo: 2. mono: 2 (same signal on both sides) or 1 on a 1-channel device.
 */
function outputChannelCount(mode, sourceChannels, outputChannels) {
	switch (mode) {
		case "multichannel":
			return Math.max(2, Math.min(sourceChannels, outputChannels));
		case "stereo":
			return 2;
		case "mono":
			return Math.min(2, outputChannels);
		default:
			throw new Error("Unknown output mode: " + mode);
	}
}

function clamp16(v) {
	return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/**
 * Decodes the payload of a validated RTP packet to interleaved Int16.
 * L16 is used as is. L24 keeps the upper 16 bits of each sample (truncation,
 * the same as the current playback path in audio.js, which reads the first two
 * bytes of every sample). Samples are big endian (RFC 3551 §4.5.11, RFC 3190).
 * The caller must have checked the packet length against the SDP.
 * @returns {Int16Array} frames * channels samples, interleaved.
 */
function decodePcm16(buffer, headerLength, frames, channels, bytesPerSample) {
	if (bytesPerSample !== 2 && bytesPerSample !== 3) {
		throw new Error("Unsupported bytesPerSample: " + bytesPerSample);
	}
	const count = frames * channels;
	if (headerLength + count * bytesPerSample > buffer.length) {
		throw new RangeError("Packet shorter than frames * channels");
	}
	const out = new Int16Array(count);
	let pos = headerLength;
	for (let i = 0; i < count; i++) {
		out[i] = buffer.readInt16BE(pos);
		pos += bytesPerSample;
	}
	return out;
}

/**
 * Throws unless `samples` holds whole frames of `srcChannels` channels and
 * `outChannels` is a positive integer. A channel count mismatch must not be
 * hidden by dropping a partial last frame.
 * @returns {number} frame count
 */
function checkFrames(samples, srcChannels, outChannels) {
	if (!Number.isInteger(srcChannels) || srcChannels < 1) {
		throw new RangeError("Invalid source channel count: " + srcChannels);
	}
	if (!Number.isInteger(outChannels) || outChannels < 1) {
		throw new RangeError("Invalid output channel count: " + outChannels);
	}
	if (samples.length % srcChannels !== 0) {
		throw new RangeError(
			"Incomplete frame: " +
				samples.length +
				" samples, " +
				srcChannels +
				" channels"
		);
	}
	return samples.length / srcChannels;
}

/**
 * Maps interleaved source channels to `outChannels` outputs in order: source
 * channel n goes to output n. Extra source channels are dropped, missing ones
 * are silent. Throws RangeError for partial frames or invalid channel counts.
 */
function mapChannels(samples, srcChannels, outChannels) {
	const frames = checkFrames(samples, srcChannels, outChannels);
	const out = new Int16Array(frames * outChannels);
	const n = Math.min(srcChannels, outChannels);
	for (let f = 0; f < frames; f++) {
		for (let c = 0; c < n; c++) {
			out[f * outChannels + c] = samples[f * srcChannels + c];
		}
	}
	return out;
}

/**
 * Mixes all source channels down to one signal and writes it to `outChannels`
 * output channels (the same value on each). The mix is the sum of all channels
 * multiplied by `gain`, hard limited to the Int16 range. gain = 1 is a plain
 * sum (can clip when many channels carry signal); gain = 1 / srcChannels is an
 * average (never clips, quieter when few channels carry signal).
 */
function mixdown(samples, srcChannels, outChannels, gain = 1) {
	const frames = checkFrames(samples, srcChannels, outChannels);
	const out = new Int16Array(frames * outChannels);
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (let c = 0; c < srcChannels; c++) {
			sum += samples[f * srcChannels + c];
		}
		const v = clamp16(Math.round(sum * gain));
		for (let c = 0; c < outChannels; c++) {
			out[f * outChannels + c] = v;
		}
	}
	return out;
}

/**
 * Allocation-free version of decodePcm16 + (mapChannels | mixdown) for the UDP
 * receive callback: reads the validated RTP payload and writes interleaved
 * little-endian Int16 output frames straight into `out` at `outOffset`, without
 * creating any array. Result is the same as the helpers above (tested).
 * mode "mono": sum of all source channels * gain, hard limited, on every output
 * channel. Any other mode (multichannel): source channel n -> output channel n,
 * extra source channels dropped, missing ones written as silence (so stale data
 * in a reused output buffer is overwritten).
 * Throws RangeError if the packet or the output buffer is too small.
 */
function renderPacket(
	out,
	outOffset,
	buffer,
	headerLength,
	frames,
	srcChannels,
	bytesPerSample,
	mode,
	outChannels,
	gain = 1
) {
	if (bytesPerSample !== 2 && bytesPerSample !== 3) {
		throw new Error("Unsupported bytesPerSample: " + bytesPerSample);
	}
	if (!Number.isInteger(srcChannels) || srcChannels < 1) {
		throw new RangeError("Invalid source channel count: " + srcChannels);
	}
	if (!Number.isInteger(outChannels) || outChannels < 1) {
		throw new RangeError("Invalid output channel count: " + outChannels);
	}
	if (headerLength + frames * srcChannels * bytesPerSample > buffer.length) {
		throw new RangeError("Packet shorter than frames * channels");
	}
	if (outOffset + frames * outChannels * 2 > out.length) {
		throw new RangeError("Output buffer too small");
	}

	const mapped = Math.min(srcChannels, outChannels);
	for (let f = 0; f < frames; f++) {
		const inBase = headerLength + f * srcChannels * bytesPerSample;
		const outBase = outOffset + f * outChannels * 2;
		if (mode === "mono") {
			let sum = 0;
			for (let c = 0; c < srcChannels; c++) {
				sum += buffer.readInt16BE(inBase + c * bytesPerSample);
			}
			const v = clamp16(Math.round(sum * gain));
			for (let c = 0; c < outChannels; c++) {
				out.writeInt16LE(v, outBase + c * 2);
			}
		} else {
			for (let c = 0; c < mapped; c++) {
				out.writeInt16LE(
					buffer.readInt16BE(inBase + c * bytesPerSample),
					outBase + c * 2
				);
			}
			for (let c = mapped; c < outChannels; c++) {
				out.writeInt16LE(0, outBase + c * 2);
			}
		}
	}
}

module.exports = {
	MODES,
	availableModes,
	resolveMode,
	outputChannelCount,
	decodePcm16,
	mapChannels,
	mixdown,
	renderPacket,
};
