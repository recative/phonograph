import { RawMetadata } from '../interfaces';

// http://www.mp3-tech.org/programmer/frame_header.html
// frame header starts with 'frame sync' – eleven 1s
export default function parseFrameHeader(data: Uint8Array, i = 0): RawMetadata | false {
	// First 11 bits should be set to 1, and the 12nd bit should be 1 if the audio is MPEG Version 1 or
	// MPEG Version 2, this means MPEG Version 2.5 is not supported by this library.
	if (data[i + 0] !== 0b11111111 || (data[i + 1] & 0b11110000) !== 0b11110000)
		return false;

	const valid = (
		// Layer Description should not be 00, since it is reserved
		(data[i + 1] & 0b00000110) !== 0b00000000 &&
		// Bitrate should not be 1111, since it is bad
		(data[i + 2] & 0b11110000) !== 0b11110000 &&
		// Sampling Rate Frequency should not be 11, the value is reserved
		(data[i + 2] & 0b00001100) !== 0b00001100
	);

	if (!valid) return false;

	return {
			mpegVersion: data[i + 1] & 0b00001000,
			mpegLayer: data[i + 1] & 0b00000110,
			sampleRate: data[i + 2] & 0b00001100,
			channelMode: data[i + 3] & 0b11000000
		}
}
