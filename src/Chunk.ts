import { AudioContext, IAudioBuffer, IAudioBufferSourceNode } from 'standardized-audio-context';

import { slice } from './utils/buffer';
import { IAdapter } from './adapters/IAdapter';

import Clip from './Clip';

export default class Chunk<Metadata>{
	clip: Clip<Metadata>;
	context: AudioContext;
	duration: number | null = null;
	numFrames: number | null = null;
	raw: Uint8Array;
	extended: Uint8Array | null;
	ready: boolean;
	next: Chunk<Metadata> | null = null;
	readonly adapter: IAdapter<Metadata>;

	_attached: boolean;
	_callback: (() => void) | null = null;
	_firstByte: number;

	constructor({
		clip,
		raw,
		onready,
		onerror,
		adapter,
	}: {
		clip: Clip<Metadata>;
		raw: Uint8Array;
		onready: (() => void) | null;
		onerror: (error: Error) => void;
		adapter: IAdapter<Metadata>
	}) {
		this.clip = clip;
		this.context = clip.context;

		this.raw = raw;
		this.extended = null;

		this.adapter = adapter;

		this.duration = null;
		this.ready = false;

		this._attached = false;
		this._callback = onready;

		this._firstByte = 0;

		const decode = (callback: () => void, errback: (err: Error) => void) => {
			const buffer = slice(raw, this._firstByte, raw.length).buffer;

			this.context.decodeAudioData(buffer, callback, err => {
				if (err) return errback(err);

				this._firstByte += 1;

				// filthy hack taken from http://stackoverflow.com/questions/10365335/decodeaudiodata-returning-a-null-error
				// Thanks Safari developers, you absolute numpties
				for (; this._firstByte < raw.length - 1; this._firstByte += 1) {
					if (this.adapter.validateChunk(raw, this._firstByte)) {
						return decode(callback, errback);
					}
				}

				errback(new Error(`Could not decode audio buffer`));
			});
		};

		decode(() => {
			let numFrames = 0;
			let duration = 0;
			let i = this._firstByte

			while (i < this.raw.length) {
				if (this.adapter.validateChunk(this.raw, i)) {
					const metadata = this.adapter.getChunkMetadata(this.raw, i);
					numFrames += 1;

					const frameLength = this.adapter.getChunkLength(this.raw, metadata, i);
					i += Math.max(frameLength ?? 0, 4);
					duration += this.adapter.getChunkDuration(this.raw, metadata, i) ?? 0;
				} else {
					i += 1
				}
			}

			this.duration = duration;
			this.numFrames = numFrames;
			this._ready();
		}, onerror);
	}

	attach(nextChunk: Chunk<Metadata> | null) {
		this.next = nextChunk;
		this._attached = true;

		this._ready();
	}

	createBuffer(callback: (source: IAudioBuffer) => void, errback: (error: Error) => void) {
		if (!this.ready) {
			throw new Error(
				'Something went wrong! Chunk was not ready in time for playback'
			);
		}

		this.context.decodeAudioData(
			slice(this.extended!, 0, this.extended!.length).buffer,
			decoded => {
				callback(decoded);
			},
			errback
		);
	}

	onready(callback: () => void) {
		if (this.ready) {
			setTimeout(callback);
		} else {
			this._callback = callback;
		}
	}

	_ready() {
		if (this.ready) return;

		if (this._attached && this.duration !== null) {
			this.ready = true;

			if (this.next) {
				const rawLen = this.raw.length;
				const nextLen = this.next.raw.length >> 1; // we don't need the whole thing

				this.extended = new Uint8Array(rawLen + nextLen);

				let p = 0;

				for (let i = this._firstByte; i < rawLen; i += 1) {
					this.extended[p++] = this.raw[i];
				}

				for (let i = 0; i < nextLen; i += 1) {
					this.extended[p++] = this.next.raw[i];
				}
			} else {
				this.extended =
					this._firstByte > 0
						? slice(this.raw, this._firstByte, this.raw.length)
						: this.raw;
			}

			if (this._callback) {
				this._callback();
				this._callback = null;
			}
		}
	}
}
