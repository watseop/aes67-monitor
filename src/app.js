import { ref, computed } from "vue";
import { findGroups } from "./lib/groups.js";

export const page = ref("streams");
export const search = ref({ streams: "", interfaces: "", devices: "" });
export const streamCount = ref(0);
export const channelCount = ref(0);
export const interfaceCount = ref(0);
export const streams = ref([]);
export const streamCountDisplay = ref(true);
export const audioInterfaces = ref([]);
export const networkInterfaces = ref([]);
export const selectedStream = ref(null);
export const selectedChannel = ref([]);
export const streamIndex = ref([]);
export const visibleStreams = ref(0);
export const playing = ref("");
// Stream groups (one source announced as several streams): group key -> expanded
export const expandedGroups = ref({});
export const toggleGroup = (key) => {
	expandedGroups.value[key] = !expandedGroups.value[key];
};
// Latest per-channel levels of the playing stream: {id, active, peak[], rms[]} (dBFS)
export const levels = ref(null);
let levelsUpdatedAt = 0;
// Hide the meter if reports stop (audio process stopped or restarted).
setInterval(() => {
	if (levels.value && Date.now() - levelsUpdatedAt > 1000) {
		levels.value = null;
	}
}, 500);
export const persistentData = ref({
	settings: {
		bufferSize: 16,
		bufferEnabled: true,
		hideUnsupported: true,
		sdpDeleteTimeout: 300,
		sidebarCollapsed: false,
	},
});

export const rawSDP = ref({
	sdp: "",
	announce: false,
});

export const isBackBtnActive = () => {
	if (page.value == "stream" || page.value == "sdp") {
		return true;
	}

	return false;
};

export const goBack = () => {
	switch (page.value) {
		case "stream":
			page.value = "streams";
			break;
		case "sdp":
			page.value = "streams";
			break;
	}
};

export const getTitle = () => {
	switch (page.value) {
		case "stream":
			return selectedStream.value.name;
		case "sdp":
			return "Add Stream";
		case "interfaces":
			return "Audio Interfaces";
	}

	return page.value.charAt(0).toUpperCase() + page.value.slice(1);
};

export const isPageSearchable = () => {
	if (page.value == "streams" || page.value == "devices") {
		return true;
	}

	return false;
};

export const viewPage = (newPage) => {
	if (page.value == "settings") {
		saveSettings();
	}
	page.value = newPage;
};

export const getPageTitle = () => {
	switch (page.value) {
		case "stream":
			return "Streams";
		case "sdp":
			return "Streams";
	}
};

export const setSidebarStatus = (status) => {
	persistentData.value.settings.sidebarCollapsed = status;
	updatePersistentData("settings");
};

export const searchStreams = () => {
	let filteredStream = streams.value.filter((stream) => {
		return (
			(stream.name.toLowerCase().includes(search.value.streams.toLowerCase()) ||
				stream.origin.address
					.toLowerCase()
					.includes(search.value.streams.toLowerCase()) ||
				stream.id.includes(search.value.streams)) &&
			(stream.isSupported || !persistentData.value.settings.hideUnsupported)
		);
	});

	visibleStreams.value = filteredStream.length;
	return filteredStream;
};

export const searchDevices = computed(() => {
	const devices = [...new Set(streams.value.map((obj) => obj.origin.address))];

	if (!persistentData.value.devices) {
		persistentData.value.devices = {};
	}

	for (let i = 0; i < devices.length; i++) {
		if (persistentData.value.devices[devices[i]] === undefined) {
			persistentData.value.devices[devices[i]] = {
				name: devices[i],
				description: "-",
				count: streams.value.filter(
					(stream) => stream.origin.address == devices[i]
				).length,
			};
		} else {
			persistentData.value.devices[devices[i]].count = streams.value.filter(
				(stream) => stream.origin.address == devices[i]
			).length;
		}
	}

	return devices.filter((device) => {
		return (
			device.includes(search.value.devices) ||
			persistentData.value.devices[device].name
				.toLowerCase()
				.includes(search.value.devices.toLowerCase()) ||
			persistentData.value.devices[device].description
				.toLowerCase()
				.includes(search.value.devices.toLowerCase())
		);
	});
});

export const getDate = (timestamp) => {
	return new Date(timestamp).toLocaleString();
};

export const viewDevice = (device) => {
	search.value.streams = device;
	page.value = "streams";
	document.getElementById("search-input").focus();
};

export const getTextareaRowNumber = () => {
	return selectedStream.value.raw
		.split("\n")
		.filter((line) => line.trim() !== "").length;
};

export const viewStream = (stream) => {
	page.value = "stream";
	selectedStream.value = stream;
};

export const isDevMode = () => {
	return process.env.NODE_ENV === "development";
};

export const getAudioOutputDevices = () => {
	return audioInterfaces.value.filter((device) => {
		return device.outputChannels > 0;
	});
};

export const getCurrentAudioOutput = () => {
	return audioInterfaces.value.filter((device) => {
		return device.outputChannels > 0 && device.isCurrent;
	});
};

export const getCurrentSupportedSampleRates = () => {
	let currentDevice = getCurrentAudioOutput();
	return currentDevice.length > 0 ? currentDevice[0].sampleRates : [];
};

export const getAudioInputDevices = () => {
	return audioInterfaces.value.filter((device) => {
		return device.inputChannels > 0;
	});
};

export const saveSDP = () => {
	sendMessage({
		type: "addStream",
		data: {
			sdp: rawSDP.value.sdp,
			announce: rawSDP.value.announce,
		},
	});

	rawSDP.value.sdp = "";
	page.value = "streams";
};

export const getChannelSelectValues = (stream) => {
	let mono = [];
	let stereo = [];

	for (var i = 0; i < stream.channels; i += 1) {
		mono.push({
			value: i + "," + i,
			string: i + 1 + " Mono",
		});

		if (i % 2 == 0 && stream.channels > 1) {
			stereo.push({
				value: i + "," + (i + 1),
				string: i + 1 + " + " + (i + 2) + " Stereo",
			});
		}
	}

	let values = stereo.concat(mono);

	if (!selectedChannel.value[stream.id]) {
		selectedChannel.value[stream.id] = values[0].value;
		streamIndex.value[stream.id] = 0;
	}

	return values;
};

// Group monitoring: all member streams of one group are received at once and
// only their levels are shown (no audio). One group at a time.
export const monitoredGroup = ref("");
// {key, members: [{id, active, peak[], rms[]}]} (dBFS), same shape as `levels`
export const groupLevels = ref(null);
let groupLevelsUpdatedAt = 0;
setInterval(() => {
	if (groupLevels.value && Date.now() - groupLevelsUpdatedAt > 1000) {
		groupLevels.value = null;
	}
}, 500);

// Receive descriptors for every member of a group; null if one has no RTP info.
const monitorStreams = (group) => {
	const out = [];
	for (const stream of group.members) {
		const media = stream.media[0];
		if (!media || !media.rtp[0]) {
			console.error("Cannot monitor group, stream without RTP info", stream.id);
			return null;
		}
		out.push({
			id: stream.id,
			mcast: stream.mcast,
			port: media.port,
			codec: media.rtp[0].codec,
			samplerate: media.rtp[0].rate,
			channels: media.rtp[0].encoding,
			ptime: media.ptime,
			filter: !!media.sourceFilter,
			filterAddr: media.sourceFilter ? media.sourceFilter.srcList : "",
		});
	}
	return out;
};

// JSON of the descriptors sent to the monitor, to detect member changes.
let monitoredSignature = "";

const stopGroupMonitor = () => {
	monitoredGroup.value = "";
	monitoredSignature = "";
	groupLevels.value = null;
	sendMessage({ type: "stopMonitorGroup" });
};

export const toggleGroupMonitor = (group) => {
	groupLevels.value = null;
	if (monitoredGroup.value === group.key) {
		stopGroupMonitor();
		return;
	}
	const list = monitorStreams(group);
	if (!list) {
		return;
	}
	monitoredGroup.value = group.key;
	monitoredSignature = JSON.stringify(list);
	sendMessage({
		type: "monitorGroup",
		data: { key: group.key, streams: list },
	});
};

// Called on every stream list update: if members of the monitored group were
// added, removed or changed, restart reception with the new list; if the group
// no longer exists (e.g. its key changed), stop.
const reconcileGroupMonitor = () => {
	if (!monitoredGroup.value) {
		return;
	}
	let group = null;
	for (const g of findGroups(streams.value).values()) {
		if (g.key === monitoredGroup.value) {
			group = g;
			break;
		}
	}
	const list = group ? monitorStreams(group) : null;
	if (!list) {
		stopGroupMonitor();
		return;
	}
	const signature = JSON.stringify(list);
	if (signature !== monitoredSignature) {
		monitoredSignature = signature;
		sendMessage({
			type: "monitorGroup",
			data: { key: monitoredGroup.value, streams: list },
		});
	}
};

export const playStream = (stream) => {
	levels.value = null;
	if (playing.value == stream.id) {
		playing.value = "";
		sendMessage({ type: "stop" });
	} else {
		playing.value = stream.id;

		let channelMapping = selectedChannel.value[stream.id].split(",");
		let streamMapping = streamIndex.value[stream.id];
		let channel0 = parseInt(channelMapping[0]);
		let channel1 = parseInt(channelMapping[1]);

		if (stream.media[streamMapping] && stream.media[streamMapping].rtp[0]) {
			let samplerate = stream.media[streamMapping].rtp[0].rate;
			let channels = stream.media[streamMapping].rtp[0].encoding;
			let ptime = stream.media[streamMapping].ptime;
			let codec = stream.media[streamMapping].rtp[0].codec;
			let port = stream.media[streamMapping].port;
			let mcast = stream.mcast;
			let filter = false;
			let filterAddr = "";

			if (streamMapping > 0) {
				mcast = stream.media[streamMapping].connection.ip.split("/")[0];
			}

			if (stream.media[streamMapping].sourceFilter) {
				filter = true;
				filterAddr = stream.media[streamMapping].sourceFilter.srcList;
			}

			let data = {
				id: stream.id,
				mcast: mcast,
				port: port,
				codec: codec,
				ptime: ptime,
				samplerate: samplerate,
				channels: channels,
				ch1Map: channel0,
				ch2Map: channel1,
				jitterBufferEnabled: persistentData.value.settings.bufferEnabled,
				jitterBufferSize: persistentData.value.settings.bufferSize,
				filter: filter,
				filterAddr: filterAddr,
			};

			console.log(data);
			sendMessage({
				type: "play",
				data: data,
			});
		} else {
			console.error("Error playing stream");
		}
	}
};

export const setCurrentAudioInterface = (device) => {
	sendMessage({
		type: "setAudioInterface",
		data: {
			inputChannels: device.inputChannels,
			outputChannels: device.outputChannels,
			name: device.name,
		},
	});

	if (playing.value != "") {
		console.log("Triggering restart");
		sendMessage({ type: "restart" });
	}
};

export const sendMessage = (message) => {
	if (window && window.electronAPI) {
		window.electronAPI.sendMessage(message);
	} else {
		console.error("Could not send message to backend!");
	}
};

export const updatePersistentData = (key) => {
	sendMessage({
		type: "save",
		key: key,
		data: JSON.stringify(persistentData.value[key]),
	});
};

export const saveSettings = () => {
	const address = document.getElementById("networkSelect").value;
	updatePersistentData("settings");
	sendMessage({ type: "setNetwork", data: address });
	page.value = "streams";
};

if (window.electronAPI) {
	window.electronAPI.recvMessage((message) => {
		switch (message.type) {
			case "streams":
				streams.value = message.data;
				streamCount.value = message.data.length;
				reconcileGroupMonitor();
				break;
			case "devices":
				console.log("devices", message.data);
				break;
			case "interfaces":
				networkInterfaces.value = message.data;
				break;
			case "audioDevices":
				audioInterfaces.value = message.data;
				interfaceCount.value = message.data.length;
				break;
			case "levels":
				if (message.data.id === playing.value) {
					levels.value = message.data;
					levelsUpdatedAt = Date.now();
				}
				break;
			case "groupLevels":
				if (message.data.key === monitoredGroup.value) {
					groupLevels.value = message.data;
					groupLevelsUpdatedAt = Date.now();
				}
				break;
			case "updatePersistentData":
				persistentData.value = message.data;
				break;
			default:
				console.log(message.type, message.data);
		}
	});

	sendMessage({ type: "update" });
} else {
	console.log("Running outside of electron");
}
