/**
 * Output channel routing for group playback (pure functions, no I/O).
 *
 * A group is a list of member streams whose channels are numbered
 * consecutively (member 0 = channels 0..n0-1, member 1 = n0..). Three output
 * modes (docs/ROADMAP.md, user decisions 2026-11-11):
 *  - "multi":  group channel i -> output channel i, in order. Channels beyond
 *              the device's output channels are dropped, unused outputs stay silent.
 *  - "stereo": one chosen pair of group channels -> L/R.
 *  - "mono":   every group channel is mixed down and sent to L and R (or to the
 *              only output on a 1-channel device). The mix is the average of all
 *              group channels (gain 1 / groupChannels; user decision 2026-11-17),
 *              so it cannot clip, but it is quieter when few channels carry signal.
 *
 * Payload layout: RFC 3551 §4.1 / §4.5.11 (interleaved, signed, big endian),
 * RFC 3190 for L24. Like audio.js, playback uses the top 16 bits of a sample.
 */

const MODES = ["multi", "stereo", "mono"];

/** Modes the device can do, best first (multi > stereo > mono). */
function availableModes(outputChannels) {
	const modes = [];
	if (outputChannels > 2) modes.push("multi");
	if (outputChannels >= 2) modes.push("stereo");
	if (outputChannels >= 1) modes.push("mono");
	return modes;
}

/** Number of output channels to open for a mode. */
function outputChannelCount(mode, groupChannels, outputChannels) {
	switch (mode) {
		case "multi":
			return Math.max(1, Math.min(groupChannels, outputChannels));
		case "stereo":
			return 2;
		case "mono":
			return outputChannels >= 2 ? 2 : 1;
		default:
			throw new Error("Unknown output mode: " + mode);
	}
}

/**
 * Gain applied to the mixed output. Mono averages all group channels; the other
 * modes copy channels one to one (gain 1).
 */
function outputGain(mode, groupChannels) {
	return mode === "mono" && groupChannels > 1 ? 1 / groupChannels : 1;
}

/**
 * Builds destination lists. routes[g] = output channel indexes that group
 * channel g is added to (may be empty).
 * @param {string} mode
 * @param {number} groupChannels - total channels of the group.
 * @param {number} outChannels - channels opened on the device (outputChannelCount).
 * @param {number[]} [pair] - stereo only: [left, right] group channel indexes.
 */
function buildRoutes(mode, groupChannels, outChannels, pair) {
	const routes = [];
	for (let g = 0; g < groupChannels; g++) {
		routes.push([]);
	}
	if (mode === "multi") {
		for (let g = 0; g < groupChannels && g < outChannels; g++) {
			routes[g].push(g);
		}
	} else if (mode === "stereo") {
		const left = pair && pair[0] < groupChannels ? pair[0] : 0;
		const right =
			pair && pair[1] < groupChannels
				? pair[1]
				: Math.min(1, groupChannels - 1);
		routes[left].push(0);
		routes[right].push(1);
	} else if (mode === "mono") {
		for (let g = 0; g < groupChannels; g++) {
			for (let o = 0; o < outChannels; o++) {
				routes[g].push(o);
			}
		}
	} else {
		throw new Error("Unknown output mode: " + mode);
	}
	return routes;
}

/**
 * Mixes one aligned packet set into an interleaved Int16LE buffer.
 * @param {Buffer} out - Int16LE, frames * outChannels samples, overwritten.
 * @param {Int32Array} acc - scratch, length >= frames * outChannels.
 * @param {Array<null|{buffer: Buffer, headerLength: number}>} packets - one
 *   per member; null = member packet missing, its channels are silent.
 * @param {Object} cfg - { members: [{channels, bytesPerSample, offset}], routes,
 *   outChannels, frames, gain }; offset = index of the member's first group
 *   channel; gain (default 1) scales the mixed sum, see outputGain().
 */
function mixPackets(out, acc, packets, cfg) {
	const { members, routes, outChannels, frames } = cfg;
	const gain = cfg.gain === undefined ? 1 : cfg.gain;
	const total = frames * outChannels;
	acc.fill(0, 0, total);

	for (let m = 0; m < members.length; m++) {
		const p = packets[m];
		if (!p) continue;
		const { channels, bytesPerSample, offset } = members[m];
		// Never read past the packet (caller validated the length; double check).
		if (p.headerLength + frames * channels * bytesPerSample > p.buffer.length) {
			continue;
		}
		for (let c = 0; c < channels; c++) {
			const dest = routes[offset + c];
			if (!dest || dest.length === 0) continue;
			let pos = p.headerLength + c * bytesPerSample;
			const step = channels * bytesPerSample;
			for (let f = 0; f < frames; f++) {
				const v = p.buffer.readInt16BE(pos);
				for (let d = 0; d < dest.length; d++) {
					acc[f * outChannels + dest[d]] += v;
				}
				pos += step;
			}
		}
	}

	for (let i = 0; i < total; i++) {
		const v = gain === 1 ? acc[i] : Math.round(acc[i] * gain);
		out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i * 2);
	}
}

module.exports = {
	MODES,
	availableModes,
	outputChannelCount,
	outputGain,
	buildRoutes,
	mixPackets,
};
