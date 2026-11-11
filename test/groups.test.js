const test = require("node:test");
const assert = require("node:assert");
const {
	parseStreamName,
	findGroups,
	groupRanges,
	groupSpan,
	buildRows,
} = require("../src/lib/groups.js");

function s(id, name, channels, extra) {
	return Object.assign(
		{
			id,
			name,
			isSupported: true,
			origin: { address: "172.16.0.75" },
			codec: "L24",
			samplerate: 48000,
			channels,
			media: [{ ptime: 1 }],
		},
		extra
	);
}

test("parseStreamName", () => {
	assert.deepStrictEqual(parseStreamName("Main 1-2-9"), {
		base: "Main 1-2",
		start: 9,
	});
	assert.deepStrictEqual(parseStreamName("STUDIO 7.1.4-1"), {
		base: "STUDIO 7.1.4",
		start: 1,
	});
	assert.strictEqual(parseStreamName("Combo 1/2"), null);
	assert.strictEqual(parseStreamName("Combo 1/2-1_2qm"), null);
	assert.strictEqual(parseStreamName("Name-0"), null);
	assert.strictEqual(parseStreamName(""), null);
	assert.strictEqual(parseStreamName(undefined), null);
});

test("8 ch + 4 ch from one source form one 12 ch group", () => {
	const a = s("a", "Anubis_Main 1-2-1", 8);
	const b = s("b", "Anubis_Main 1-2-9", 4);
	const groups = findGroups([b, a]);
	assert.strictEqual(groups.get("a"), groups.get("b"));
	const g = groups.get("a");
	assert.strictEqual(g.channels, 12);
	assert.strictEqual(g.name, "Anubis_Main 1-2");
	assert.deepStrictEqual(
		g.members.map((m) => m.id),
		["a", "b"]
	);
});

test("gap in channel ranges is not grouped", () => {
	const a = s("a", "X-1", 8);
	const b = s("b", "X-10", 4); // 1+8 = 9, not 10
	assert.strictEqual(findGroups([a, b]).size, 0);
});

test("different origin address is not grouped", () => {
	const a = s("a", "X-1", 8);
	const b = s("b", "X-9", 4, { origin: { address: "172.16.0.72" } });
	assert.strictEqual(findGroups([a, b]).size, 0);
});

test("different format is not grouped", () => {
	const a = s("a", "X-1", 8);
	assert.strictEqual(
		findGroups([a, s("b", "X-9", 4, { samplerate: 96000 })]).size,
		0
	);
	assert.strictEqual(
		findGroups([a, s("c", "X-9", 4, { codec: "L16" })]).size,
		0
	);
	assert.strictEqual(
		findGroups([a, s("d", "X-9", 4, { media: [{ ptime: 0.25 }] })]).size,
		0
	);
});

test("unsupported streams are never grouped", () => {
	const a = s("a", "X-1", 8);
	const b = s("b", "X-9", 4, { isSupported: false });
	assert.strictEqual(findGroups([a, b]).size, 0);
});

test("mono streams with unrelated names are not merged", () => {
	const list = [
		s("a", "Combo 1/2", 2),
		s("b", "Combo 1/2-1", 1),
		s("c", "Combo 1/2-1_2qm", 1),
		s("d", "Jack 3/4-1", 1),
	];
	assert.strictEqual(findGroups(list).size, 0);
});

test("three-stream chain and an unrelated stream with the same base", () => {
	const list = [
		s("a", "Y-1", 8),
		s("b", "Y-9", 4),
		s("c", "Y-13", 4),
		s("z", "Y-30", 2),
	];
	const groups = findGroups(list);
	assert.strictEqual(groups.get("a").channels, 16);
	assert.strictEqual(groups.get("a").members.length, 3);
	assert.strictEqual(groups.has("z"), false);
});

test("duplicate start does not join the chain", () => {
	const list = [s("a", "Y-1", 8), s("b", "Y-1", 8), s("c", "Y-9", 4)];
	const groups = findGroups(list);
	// Exactly one chain of 2 is formed; the duplicate stays standalone.
	const grouped = list.filter((x) => groups.has(x.id));
	assert.strictEqual(grouped.length, 2);
	assert.strictEqual(groups.get("c").members.length, 2);
});

test("buildRows: group row at first member position, members only when expanded", () => {
	const list = [
		s("p", "A", 2),
		s("b", "Main-9", 4),
		s("q", "B", 2),
		s("a", "Main-1", 8),
	];
	const collapsed = buildRows(list, {});
	assert.deepStrictEqual(
		collapsed.map((r) => (r.group ? "G" : r.stream.id)),
		["p", "G", "q"]
	);
	const key = collapsed[1].group.key;
	const expanded = buildRows(list, { [key]: true });
	assert.deepStrictEqual(
		expanded.map((r) => (r.group ? "G" : r.stream.id)),
		["p", "G", "a", "b", "q"]
	);
	assert.strictEqual(expanded[2].inGroup, true);
	assert.strictEqual(expanded[0].inGroup, false);
});

test("buildRows keeps row keys unique", () => {
	const list = [s("a", "Main-1", 8), s("b", "Main-9", 4)];
	const key = findGroups(list).get("a").key;
	const rows = buildRows(list, { [key]: true });
	assert.strictEqual(new Set(rows.map((r) => r.key)).size, rows.length);
});

test("groupRanges uses the start channels from the names", () => {
	const from1 = findGroups([s("a", "M-1", 8), s("b", "M-9", 4)]).get("a");
	assert.strictEqual(groupRanges(from1), "1-8, 9-12");

	const from9 = findGroups([s("c", "Source-9", 8), s("d", "Source-17", 8)]).get(
		"c"
	);
	assert.strictEqual(from9.channels, 16);
	assert.strictEqual(groupRanges(from9), "9-16, 17-24");
});

test("groupSpan is short even for many members", () => {
	const list = [];
	for (let i = 0; i < 17; i++) {
		list.push(s("id" + i, "Dev-" + (1 + i * 8), 8));
	}
	const g = findGroups(list).get("id0");
	assert.strictEqual(g.members.length, 17);
	assert.strictEqual(groupSpan(g), "1-136");
	assert.ok(groupRanges(g).length > 60); // the detailed form is long
	const g2 = findGroups([s("a", "S-9", 8), s("b", "S-17", 8)]).get("a");
	assert.strictEqual(groupSpan(g2), "9-24");
});
