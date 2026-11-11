/**
 * RTP fixed header helpers (RFC 3550 §5.1, §5.3.1).
 * Used by the group monitor; audio.js keeps its own inline parsing.
 */

/**
 * Returns the RTP header length in bytes, including CSRC list and header
 * extension, or -1 if the packet is too short to contain what its header says.
 *
 * RFC 3550 §5.1: the fixed header is 12 bytes, followed by CC (low 4 bits of the
 * first byte) 32-bit CSRC identifiers. §5.3.1: if the X bit is set, a header
 * extension follows: 16 bits profile, 16 bits length counting 32-bit words of
 * extension data (excluding these 4 bytes).
 * @param {Buffer} buffer - the UDP payload.
 * @returns {number}
 */
function rtpHeaderLength(buffer) {
	if (!buffer || buffer.length < 12) {
		return -1;
	}
	const firstByte = buffer[0];
	let length = 12 + (firstByte & 0x0f) * 4;
	if (firstByte & 0x10) {
		if (buffer.length < length + 4) {
			return -1;
		}
		length += 4 + buffer.readUInt16BE(length + 2) * 4;
	}
	return buffer.length < length ? -1 : length;
}

module.exports = { rtpHeaderLength };
