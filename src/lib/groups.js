/**
 * Groups streams that one source advertises as several SAP streams.
 *
 * Example (observed with an Anubis, 12 channel 7.1.4 source): the source is
 * announced as "<name>-1" (8 ch) and "<name>-9" (4 ch). The number after the
 * last "-" is the first channel of that stream, so the streams are one logical
 * source when the channel ranges join without a gap (1 + 8 = 9).
 *
 * This is a naming heuristic, not part of AES67 / SDP. It is deliberately
 * strict so unrelated streams are not merged: a stream is only grouped when
 *  - it is supported, from the same origin address, with the same base name
 *    (the name without the trailing "-<first channel>"),
 *  - codec, sample rate and packet time are identical,
 *  - the channel ranges form a gapless chain (next start = start + channels).
 * Everything else stays a standalone stream. Pure functions, no I/O.
 */

/**
 * Splits "Main 1-2-9" into { base: "Main 1-2", start: 9 }.
 * Returns null if the name has no trailing "-<number>".
 */
function parseStreamName(name) {
	const match = /^(.*\S)-(\d+)$/.exec(name || "");
	if (!match) {
		return null;
	}
	const start = parseInt(match[2], 10);
	if (start < 1) {
		return null;
	}
	return { base: match[1], start };
}

function candidateKey(stream, base) {
	const ptime = stream.media && stream.media[0] ? stream.media[0].ptime : "";
	return [
		stream.origin && stream.origin.address,
		base,
		stream.codec,
		stream.samplerate,
		ptime,
	].join("|");
}

/**
 * Finds groups in a list of streams.
 * @param {Object[]} streams - parsed SDP streams (see sdp.js preParse).
 * @returns {Map<string, Object>} stream id -> group
 *   group = { key, name, address, members, channels, codec, samplerate }
 *   members are sorted by first channel.
 */
function findGroups(streams) {
	const candidates = new Map();

	for (const stream of streams) {
		if (!stream.isSupported || !(stream.channels >= 1)) {
			continue;
		}
		const parsed = parseStreamName(stream.name);
		if (!parsed) {
			continue;
		}
		const key = candidateKey(stream, parsed.base);
		if (!candidates.has(key)) {
			candidates.set(key, []);
		}
		candidates
			.get(key)
			.push({ stream, start: parsed.start, base: parsed.base });
	}

	const byStreamId = new Map();

	for (const [key, entries] of candidates) {
		entries.sort((a, b) => a.start - b.start);

		let chain = [];
		const flush = () => {
			if (chain.length >= 2) {
				const first = chain[0];
				const group = {
					key: key + "|" + first.start,
					name: first.base,
					address: first.stream.origin.address,
					members: chain.map((e) => e.stream),
					// First channel of each member, taken from its name suffix.
					starts: chain.map((e) => e.start),
					channels: chain.reduce((sum, e) => sum + e.stream.channels, 0),
					codec: first.stream.codec,
					samplerate: first.stream.samplerate,
				};
				for (const e of chain) {
					byStreamId.set(e.stream.id, group);
				}
			}
			chain = [];
		};

		for (const entry of entries) {
			if (chain.length === 0) {
				chain.push(entry);
				continue;
			}
			const last = chain[chain.length - 1];
			if (entry.start === last.start + last.stream.channels) {
				chain.push(entry);
			} else {
				// Gap or duplicate start: close the chain, start a new one here.
				flush();
				chain.push(entry);
			}
		}
		flush();
	}

	return byStreamId;
}

/**
 * Channel range of each member as shown in the UI, e.g. "1-8, 9-12".
 * Uses the start channel parsed from each member's name, so a group that does
 * not begin at channel 1 (e.g. "Source-9", "Source-17") shows "9-16, 17-24".
 */
function groupRanges(group) {
	return group.members
		.map((member, i) => {
			const start = group.starts[i];
			return start + "-" + (start + member.channels - 1);
		})
		.join(", ");
}

/**
 * Overall channel span of a group, e.g. "1-136". Short enough for a table
 * cell even for groups with many members; groupRanges() has the detail.
 */
function groupSpan(group) {
	const last = group.members.length - 1;
	const end = group.starts[last] + group.members[last].channels - 1;
	return group.starts[0] + "-" + end;
}

/**
 * Turns an ordered stream list into display rows. A group row is placed where
 * its first member appears in the list; member rows follow it when expanded.
 * @param {Object[]} streams - already filtered and sorted streams.
 * @param {Object} expanded - group key -> true when the group is expanded.
 * @returns {Object[]} rows: { key, group?, stream?, inGroup?, range? }
 */
function buildRows(streams, expanded) {
	const groups = findGroups(streams);
	const rows = [];
	const emitted = new Set();

	for (const stream of streams) {
		const group = groups.get(stream.id);
		if (!group) {
			rows.push({ key: stream.id, stream, inGroup: false });
			continue;
		}
		if (emitted.has(group.key)) {
			continue;
		}
		emitted.add(group.key);
		rows.push({ key: "group:" + group.key, group });
		if (expanded && expanded[group.key]) {
			group.members.forEach((member, i) => {
				const start = group.starts[i];
				rows.push({
					key: member.id,
					stream: member,
					inGroup: true,
					// Channel range of this member within the source, e.g. "9-12".
					range: start + "-" + (start + member.channels - 1),
				});
			});
		}
	}

	return rows;
}

module.exports = {
	parseStreamName,
	findGroups,
	groupRanges,
	groupSpan,
	buildRows,
};
