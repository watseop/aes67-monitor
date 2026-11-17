<template>
	<div class="row">
		<div class="col-4">
			<h5 class="mb-3">Network</h5>
			<select
				class="form-select"
				aria-label="Default select example"
				id="networkSelect"
			>
				<option
					v-for="networkInterface in networkInterfaces"
					:key="networkInterface.name"
					:value="networkInterface.address"
					:selected="networkInterface.isCurrent"
				>
					{{ networkInterface.name }}: {{ networkInterface.address }}
				</option>
			</select>
		</div>
		<div class="col-4">
			<h5 class="mb-3">Audio Buffering</h5>
			<div class="form-check">
				<input
					class="form-check-input"
					type="checkbox"
					id="check-buffering"
					v-model="persistentData.settings.bufferEnabled"
				/>
				<label class="form-check-label" for="check-buffering">
					Enable Buffering
				</label>
			</div>
			<div class="input-group mb-3">
				<input
					type="number"
					v-model="persistentData.settings.bufferSize"
					class="form-control"
				/>
				<span class="input-group-text">packets</span>
			</div>
			<h5 class="mb-3 mt-4">Output Mode</h5>
			<select class="form-select" id="outputModeSelect" v-model="outputMode">
				<option
					v-for="mode in outputModes"
					:key="mode.value"
					:value="mode.value"
					:disabled="!mode.available"
				>
					{{ mode.label }}
				</option>
			</select>
			<div class="form-text mb-3">
				Multichannel needs an output device with more than 2 channels. Mono
				mixes all channels together and plays them on both sides.
			</div>
		</div>
		<div class="col-4">
			<h5 class="mb-3">Other</h5>
			<div class="form-check mb-3">
				<input
					class="form-check-input"
					type="checkbox"
					id="check-unsupported"
					v-model="persistentData.settings.hideUnsupported"
				/>
				<label class="form-check-label" for="check-unsupported">
					Hide unsupported Streams
				</label>
			</div>
			<label for="sdp-delete-timeout-input" class="form-label"
				>SDP Delete Timeout</label
			>
			<div class="input-group mb-3">
				<input
					type="number"
					id="sdp-delete-timeout-input"
					v-model="persistentData.settings.sdpDeleteTimeout"
					class="form-control"
				/>
				<span class="input-group-text">seconds</span>
			</div>
			<div id="sdp-delete-text" class="form-text mb-3">
				Streams will be removed if no new announcement is received within
				timeout
			</div>
			<div class="form-check mb-3">
				<input
					class="form-check-input"
					type="checkbox"
					id="check-sidebar-collapsed"
					v-model="persistentData.settings.sidebarCollapsed"
				/>
				<label class="form-check-label" for="check-sidebar-collapsed">
					Collapse Sidebar
				</label>
			</div>
		</div>
	</div>
</template>

<script>
import {
	persistentData,
	networkInterfaces,
	getCurrentAudioOutput,
} from "../../app.js";
import { availableModes } from "../../lib/outputmode.js";
import { computed } from "vue";

export default {
	name: "SettingsPage",
	setup() {
		// Settings saved before this option existed have no outputMode: stereo.
		const outputMode = computed({
			get: () => persistentData.value.settings.outputMode || "stereo",
			set: (value) => {
				persistentData.value.settings.outputMode = value;
			},
		});
		const outputModes = computed(() => {
			const device = getCurrentAudioOutput()[0];
			const offered = availableModes(device ? device.outputChannels : 2);
			return [
				{ value: "multichannel", label: "Multichannel (all channels)" },
				{ value: "stereo", label: "Stereo (selected channel pair)" },
				{ value: "mono", label: "Mono (downmix to both sides)" },
			].map((mode) => ({ ...mode, available: offered.includes(mode.value) }));
		});
		return {
			persistentData,
			networkInterfaces,
			outputMode,
			outputModes,
		};
	},
};
</script>

<style></style>
