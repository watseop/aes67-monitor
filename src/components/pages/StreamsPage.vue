<template>
	<div class="alert alert-primary" role="alert" v-if="visibleStreams == 0">
		No streams found.
		<span v-if="streamCount == 0">
			It might take a few seconds for streams to show up.
		</span>
	</div>

	<table class="table table-sm table-borderless" id="streams-table">
		<thead v-if="visibleStreams > 0">
			<tr>
				<th @click="setSort('name')" style="cursor: pointer">
					Name
					<span v-if="sortKey === 'name'">
						{{ sortOrder === 1 ? "▲" : "▼" }}
					</span>
				</th>
				<th @click="setSort('tags')" style="cursor: pointer">
					Tags
					<span v-if="sortKey === 'tags'">
						{{ sortOrder === 1 ? "▲" : "▼" }}
					</span>
				</th>
				<th @click="setSort('info')" style="cursor: pointer">
					Info
					<span v-if="sortKey === 'info'">
						{{ sortOrder === 1 ? "▲" : "▼" }}
					</span>
				</th>
				<th @click="setSort('address')" style="cursor: pointer">
					Device Address
					<span v-if="sortKey === 'address'">
						{{ sortOrder === 1 ? "▲" : "▼" }}
					</span>
				</th>
				<th @click="setSort('format')" style="cursor: pointer">
					Format
					<span v-if="sortKey === 'format'">
						{{ sortOrder === 1 ? "▲" : "▼" }}
					</span>
				</th>
				<th @click="setSort('mcast')" style="cursor: pointer">
					Multicast
					<span v-if="sortKey === 'mcast'">
						{{ sortOrder === 1 ? "▲" : "▼" }}
					</span>
				</th>
				<th v-if="streamCount > 0">Channel</th>
				<th></th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			<template v-for="row in rows" :key="row.key">
				<tr v-if="row.group" class="table-active">
					<td>
						<span
							style="cursor: pointer"
							@click="toggleGroup(row.group.key)"
							:title="expandedGroups[row.group.key] ? 'Collapse' : 'Expand'"
						>
							<i
								class="bi me-1"
								:class="
									expandedGroups[row.group.key]
										? 'bi-chevron-down'
										: 'bi-chevron-right'
								"
							></i>
							{{ row.group.name }}
						</span>
						<span
							class="badge bg-info ms-2 text-nowrap"
							:title="
								row.group.members.length +
								' streams: ch ' +
								groupRanges(row.group)
							"
							>{{ row.group.channels }} ch</span
						>
					</td>
					<td></td>
					<td></td>
					<td>{{ row.group.address }}</td>
					<td>
						<span class="copy">
							{{ row.group.codec }} / {{ row.group.samplerate }}Hz /
							{{ row.group.channels }}
						</span>
					</td>
					<td></td>
					<td v-if="streamCount > 0"></td>
					<td></td>
					<td></td>
				</tr>
				<template
					v-for="stream in row.stream ? [row.stream] : []"
					:key="stream.id"
				>
					<tr>
						<td :class="{ 'ps-4': row.inGroup }">{{ stream.name }}</td>
						<td>
							<span
								class="badge bg-primary me-1"
								title="Dante device"
								v-if="stream.dante"
								>Dante</span
							>
							<span
								class="badge bg-primary me-1"
								title="ST 2022-7 redundant stream"
								v-if="
									stream.groups &&
									stream.groups[0] &&
									stream.groups[0].type == 'DUP'
								"
								>2022-7</span
							>
							<span
								class="badge bg-secondary me-1"
								title="Manually added stream"
								v-if="stream.manual"
								>Manual</span
							>
							<span
								class="badge bg-secondary me-1"
								title="Stream is broadcasted on the network via SAP"
								v-if="stream.announce"
								>SAP</span
							>
						</td>
						<td>
							{{
								stream.media[0].description ? stream.media[0].description : ""
							}}
						</td>
						<td>
							{{ stream.origin.address }}
						</td>
						<td>
							<span v-if="stream.isSupported" class="copy">
								{{ stream.codec }} / {{ stream.samplerate }}Hz /
								{{ stream.channels }}
							</span>
						</td>
						<td>
							<span
								v-if="stream.media.length > 1 && stream.isSupported"
								class="copy"
							>
								<select
									class="form-select form-select-sm"
									v-model="streamIndex[stream.id]"
									:disabled="stream.id === playing"
								>
									<template v-for="(media, index) in stream.media" :key="index">
										<option :value="index">
											{{ media.connection.ip.split("/")[0] }}:{{ media.port }}
										</option>
									</template>
								</select>
							</span>
							<span v-else class="copy"
								>{{ stream.mcast }}:{{ stream.media[0].port }}</span
							>
						</td>
						<td v-if="streamCount > 0">
							<select
								class="form-select form-select-sm"
								v-model="selectedChannel[stream.id]"
								:disabled="stream.id === playing"
								v-if="stream.isSupported"
							>
								<template
									v-for="value in getChannelSelectValues(stream)"
									:key="value.value"
								>
									<option :value="value.value">
										{{ value.string }}
									</option>
								</template>
							</select>
							<small
								v-else
								class="d-inline-flex px-2 py-1 fw-semibold text-danger-emphasis bg-danger-subtle border border-danger-subtle rounded-2"
								>{{ stream.unsupportedReason }}</small
							>
						</td>
						<td>
							<button
								class="btn btn-sm"
								:class="{
									'btn-success': stream.id !== playing,
									'btn-danger': stream.id === playing,
								}"
								@click="playStream(stream)"
								v-if="stream.isSupported"
								:disabled="
									!getCurrentSupportedSampleRates().includes(stream.samplerate)
								"
							>
								<i v-if="stream.id === playing" class="bi bi-stop-fill"></i>
								<i v-else class="bi bi-play-fill"></i>
							</button>
						</td>
						<td>
							<button
								class="btn btn-sm btn-primary"
								@click="viewStream(stream)"
							>
								<i class="bi bi-info-circle-fill"></i>
							</button>
						</td>
					</tr>
					<tr v-if="stream.id === playing && levels && levels.id === stream.id">
						<td colspan="9" class="pt-0">
							<div class="d-flex flex-wrap gap-2 align-items-end">
								<div
									v-for="(db, ch) in levels.peak"
									:key="ch"
									class="text-center"
									style="width: 44px"
									:title="
										'Ch ' +
										(ch + 1) +
										': peak ' +
										db.toFixed(1) +
										' dBFS, RMS ' +
										levels.rms[ch].toFixed(1) +
										' dBFS'
									"
								>
									<div
										class="progress"
										style="height: 40px; width: 14px; margin: 0 auto"
										role="progressbar"
									>
										<div
											class="progress-bar"
											:class="levelClass(db)"
											:style="{
												width: '100%',
												height: levelPercent(db) + '%',
												alignSelf: 'flex-end',
											}"
										></div>
									</div>
									<small class="text-muted">{{ ch + 1 }}</small>
									<div style="font-size: 0.65rem">
										<span v-if="!levels.active" class="text-muted">-</span>
										<span v-else-if="db <= silentDb" class="text-danger"
											>silent</span
										>
										<span v-else>{{ db.toFixed(0) }}</span>
									</div>
								</div>
							</div>
						</td>
					</tr>
				</template>
			</template>
		</tbody>
	</table>
</template>

<script>
import {
	searchStreams,
	streams,
	streamCount,
	viewStream,
	getChannelSelectValues,
	selectedChannel,
	playStream,
	visibleStreams,
	playing,
	persistentData,
	streamIndex,
	getCurrentSupportedSampleRates,
	levels,
	expandedGroups,
	toggleGroup,
} from "../../app.js";
import { buildRows, groupRanges } from "../../lib/groups.js";
import { ref, computed } from "vue";

export default {
	name: "StreamsPage",
	setup() {
		const sortKey = ref("name");
		const sortOrder = ref(1);

		function setSort(key) {
			if (sortKey.value === key) {
				sortOrder.value = -sortOrder.value;
			} else {
				sortKey.value = key;
				sortOrder.value = 1;
			}
		}

		function getSortValue(stream, key) {
			switch (key) {
				case "name":
					return stream.name;
				case "mcast":
					return stream.mcast;
				case "address":
					return stream.origin.address;
				case "format":
					return stream.isSupported
						? `${stream.codec} ${stream.samplerate}Hz ${stream.channels}`
						: "";
				case "info":
					return stream.media[0].description ? stream.media[0].description : "";
				case "tags":
					var tags = "";
					if (stream.dante) tags += "Dante ";
					if (stream.manual) tags += "Manual ";
					if (stream.announce) tags += "SAP ";
					if (
						stream.groups &&
						stream.groups[0] &&
						stream.groups[0].type == "DUP"
					)
						tags += "2022-7 ";
					return tags.trim();
				default:
					return stream[key];
			}
		}

		// Below this peak a channel is shown as "silent" (no signal on the source).
		const silentDb = -80;

		function levelPercent(db) {
			// Meter range -60..0 dBFS.
			return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
		}

		function levelClass(db) {
			if (db <= silentDb) return "bg-secondary";
			if (db > -3) return "bg-danger";
			if (db > -12) return "bg-warning";
			return "bg-success";
		}

		const sortedStreams = computed(() => {
			const streamsList = searchStreams();
			return streamsList.slice().sort((a, b) => {
				let propA = getSortValue(a, sortKey.value);
				let propB = getSortValue(b, sortKey.value);
				if (typeof propA === "string") propA = propA.toLowerCase();
				if (typeof propB === "string") propB = propB.toLowerCase();
				if (propA < propB) return -1 * sortOrder.value;
				if (propA > propB) return 1 * sortOrder.value;
				return 0;
			});
		});

		const rows = computed(() =>
			buildRows(sortedStreams.value, expandedGroups.value)
		);

		return {
			rows,
			groupRanges,
			expandedGroups,
			toggleGroup,
			sortedStreams,
			setSort,
			sortKey,
			sortOrder,
			searchStreams,
			streams,
			streamCount,
			viewStream,
			getChannelSelectValues,
			selectedChannel,
			playStream,
			visibleStreams,
			playing,
			persistentData,
			streamIndex,
			getCurrentSupportedSampleRates,
			levels,
			silentDb,
			levelPercent,
			levelClass,
		};
	},
};
</script>

<style></style>
