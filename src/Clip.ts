import {
	AudioContext,
	GainNode,
	IAudioBuffer,
	IAudioBufferSourceNode,
	IAudioNode
} from 'standardized-audio-context';

import warn from './utils/warn';
import Chunk from './Chunk';
import Clone from './Clone';
import { slice } from './utils/buffer';
import { Loader, FetchLoader, XhrLoader } from './Loader';
import { IAdapter } from './adapters/IAdapter';

const CHUNK_SIZE = 64 * 1024;
const OVERLAP = 0.2;

class PhonographError extends Error {
	phonographCode: string;
	url: string;

	constructor(message: string, opts: { phonographCode: string, url: string }) {
		super(message);

		this.phonographCode = opts.phonographCode;
		this.url = opts.url;
	}
}

// A cache of audio buffers starting from current time
interface AudioBufferCache<Metadata> {
	currentChunk: Chunk<Metadata> | null
	currentBuffer: IAudioBuffer | null
	nextBuffer: IAudioBuffer | null
	pendingBuffer: IAudioBuffer | null
}

export default class Clip<Metadata> {
	url: string;
	loop: boolean;
	readonly adapter: IAdapter<Metadata>;

	private callbacks: Record<string, Array<(data?: any) => void>> = {};
	context: AudioContext;

	buffered = 0;
	length = 0;
	private _loaded = false;
	public get loaded() {
		return this._loaded;
	}
	public set loaded(value) {
		this._loaded = value;
	}
	private _canplaythrough = false;
	public get canplaythrough() {
		return this._canplaythrough;
	}
	public set canplaythrough(value) {
		this._canplaythrough = value;
	}
	loader: Loader;
	metadata: Metadata | null = null;
	playing = false;
	ended = false;

	private _startTime: number = 0;
	private _currentTime = 0;
	private __chunks: Chunk<Metadata>[] = [];
	public get _chunks(): Chunk<Metadata>[] {
		return this.__chunks;
	}
	public set _chunks(value: Chunk<Metadata>[]) {
		this.__chunks = value;
	}
	private _contextTimeAtStart: number = 0;
	private _connected: boolean = false;
	private _volume: number;
	private _gain: GainNode<AudioContext>;
	private _loadStarted: boolean = false;
	private _actualPlaying = false;
	public get stuck() {
		return this.playing && !this._actualPlaying
	}
	private _currentSource: IAudioBufferSourceNode<AudioContext> | null = null
	private _nextSource: IAudioBufferSourceNode<AudioContext> | null = null
	private _audioBufferCache: AudioBufferCache<Metadata> | null = null

	constructor({
		context,
		url,
		loop,
		volume,
		adapter
	}: {
		context?: AudioContext,
		url: string,
		loop?: boolean,
		volume?: number,
		adapter: IAdapter<Metadata>
	}) {
		this.context = context || new AudioContext();
		this.url = url;
		this.loop = loop || false;
		this.adapter = adapter;

		this.loader = new ((window as any).fetch ? FetchLoader : XhrLoader)(url);

		this._volume = volume || 1;
		this._gain = this.context.createGain();
		this._gain.gain.value = this._volume;

		this._gain.connect(this.context.destination);

		this._chunks = [];
	}

	buffer(bufferToCompletion = false) {
		if (!this._loadStarted) {
			this._loadStarted = true;

			let tempBuffer = new Uint8Array(CHUNK_SIZE * 2);
			let p = 0;
			let processedBytes = 0;
			let nextFrameStartBytes = 0;

			let loadStartTime = Date.now();
			let totalLoadedBytes = 0;

			const checkCanplaythrough = () => {
				if (this.canplaythrough || !this.length) return;

				let duration = 0;
				let bytes = 0;

				for (let chunk of this._chunks) {
					if (!chunk.duration) break;
					duration += chunk.duration;
					bytes += chunk.raw.length;
				}

				if (!duration) return;

				const scale = this.length / bytes;
				const estimatedDuration = duration * scale;

				const timeNow = Date.now();
				const elapsed = timeNow - loadStartTime;

				const bitrate = totalLoadedBytes / elapsed;
				const estimatedTimeToDownload =
					1.5 * (this.length - totalLoadedBytes) / bitrate / 1e3;

				// if we have enough audio that we can start playing now
				// and finish downloading before we run out, we've
				// reached canplaythrough
				const availableAudio = bytes / this.length * estimatedDuration;

				if (availableAudio > estimatedTimeToDownload) {
					this.canplaythrough = true;
					this._fire('canplaythrough');
				}
			};

			const drainBuffer = () => {
				const isFirstChunk = this._chunks.length === 0;
				const firstByte = isFirstChunk ? 32 : 0;

				const chunk = new Chunk<Metadata>({
					clip: this,
					raw: slice(tempBuffer, firstByte, p),
					onready: () => {
						if (!this.canplaythrough) {
							checkCanplaythrough();
						}
						this.trySetupAudioBufferCache();
					},
					onerror: (error: any) => {
						error.url = this.url;
						error.phonographCode = 'COULD_NOT_DECODE';
						this._fire('loaderror', error);
					},
					adapter: this.adapter,
				});

				const lastChunk = this._chunks[this._chunks.length - 1];
				if (lastChunk) lastChunk.attach(chunk);

				this._chunks.push(chunk);
				processedBytes += p;
				p = 0;

				return chunk;
			};

			this.loader.load({
				onprogress: (progress: number, length: number, total: number) => {
					this.buffered = length;
					this.length = total;
					this._fire('loadprogress', { progress, length, total });
				},

				ondata: (uint8Array: Uint8Array) => {
					if (!this.metadata) {
						for (let i = 0; i < uint8Array.length; i += 1) {
							// determine some facts about this mp3 file from the initial header
							if (this.adapter.validateChunk(uint8Array)) {
								const metadata = this.adapter.getChunkMetadata(uint8Array);
								this.metadata = metadata;

								break;
							}
						}
					}

					for (let i = 0; i < uint8Array.length; i += 1) {
						// once the buffer is large enough, wait for
						// the next frame header then drain it
						// TODO: header detection may not works if the header is divided into two data segments.
						if (
							p + processedBytes >= nextFrameStartBytes && this.adapter.validateChunk(uint8Array, i)
						) {
							const metadata = this.adapter.getChunkMetadata(uint8Array, i);
							nextFrameStartBytes = p + processedBytes + (this.adapter.getChunkLength(uint8Array, metadata, i) ?? 0)
							if (p > CHUNK_SIZE + 4) {
								drainBuffer();
							}
						}

						// write new data to buffer
						tempBuffer[p++] = uint8Array[i];
					}

					totalLoadedBytes += uint8Array.length;
				},

				onload: () => {
					if (p) {
						const lastChunk = drainBuffer();
						lastChunk.attach(null);

						totalLoadedBytes += p;
					}

					this._chunks[0].once("ready", () => {
						if (!this.canplaythrough) {
							this.canplaythrough = true;
							this._fire('canplaythrough');
						}

						this.loaded = true;
						this._fire('load');
					});
				},

				onerror: (error: any) => {
					error.url = this.url;
					error.phonographCode = 'COULD_NOT_LOAD';
					this._fire('loaderror', error);
					this._loadStarted = false;
				}
			});
		}

		return new Promise<void>((fulfil, reject) => {
			const ready = bufferToCompletion ? this.loaded : this.canplaythrough;

			if (ready) {
				fulfil();
			} else {
				this.once(bufferToCompletion ? 'load' : 'canplaythrough', fulfil);
				this.once('loaderror', reject);
			}
		});
	}

	clone() {
		return new Clone<Metadata>(this);
	}

	connect(destination: IAudioNode<AudioContext>, output?: number, input?: number) {
		if (!this._connected) {
			this._gain.disconnect();
			this._connected = true;
		}

		this._gain.connect(destination, output, input);
		return this;
	}

	disconnect(destination: IAudioNode<AudioContext>, output?: number, input?: number) {
		this._gain.disconnect(destination, output, input);
	}

	dispose() {
		if (this.playing) this.pause();

		if (this._loadStarted) {
			this.loader.cancel();
			this._loadStarted = false;
		}

		this._currentTime = 0;
		this.loaded = false;
		this.canplaythrough = false;
		this._chunks = [];

		this._fire('dispose');
	}

	off(eventName: string, cb: (data?: any) => void) {
		const callbacks = this.callbacks[eventName];
		if (!callbacks) return;

		const index = callbacks.indexOf(cb);
		if (~index) callbacks.splice(index, 1);
	}

	on(eventName: string, cb: (data?: any) => void) {
		const callbacks =
			this.callbacks[eventName] || (this.callbacks[eventName] = []);
		callbacks.push(cb);

		return {
			cancel: () => this.off(eventName, cb)
		};
	}

	once(eventName: string, cb: (data?: any) => void) {
		const _cb = (data?: any) => {
			cb(data);
			this.off(eventName, _cb);
		};

		return this.on(eventName, _cb);
	}

	play() {
		const promise = new Promise((fulfil, reject) => {
			this.once('ended', fulfil);

			this.once('loaderror', reject);
			this.once('playbackerror', reject);

			this.once('dispose', () => {
				if (this.ended) return;

				const err = new PhonographError('Clip was disposed', {
					phonographCode: 'CLIP_WAS_DISPOSED',
					url: this.url
				});
				reject(err);
			});
		});

		if (this.playing) {
			warn(
				`clip.play() was called on a clip that was already playing (${this.url})`
			);
		} else if (!this.canplaythrough) {
			warn(
				`clip.play() was called before clip.canplaythrough === true (${this.url})`
			);
			this.buffer().then(() => this._setupPlayback());
		} else {
			this._setupPlayback();
		}

		this.playing = true;
		this.ended = false;

		return promise;
	}

	pause() {
		if (!this.playing) {
			warn(
				`clip.pause() was called on a clip that was already paused (${this.url})`
			);
			return this;
		}

		this.playing = false;
		this._actualPlaying = false;
		this._currentTime =
			this._startTime + (this.context.currentTime - this._contextTimeAtStart);

		this._fire('pause');

		return this;
	}

	get currentTime() {
		if (this.playing && this._actualPlaying) {
			return (
				this._startTime + (this.context.currentTime - this._contextTimeAtStart)
			);
		} else {
			return this._currentTime;
		}
	}

	set currentTime(currentTime) {
		if (this.playing) {
			this.pause();
			this._currentTime = currentTime;
			this._audioBufferCache = null;
			this.trySetupAudioBufferCache();
			this.play();
		} else {
			this._currentTime = currentTime;
			this._audioBufferCache = null;
			this.trySetupAudioBufferCache();
		}
	}

	get duration() {
		let total = 0;
		for (let chunk of this._chunks) {
			if (!chunk.duration) return null;
			total += chunk.duration;
		}

		return total;
	}

	get paused() {
		return !this.playing;
	}

	get volume() {
		return this._volume;
	}

	set volume(volume) {
		this._gain.gain.value = this._volume = volume;
	}

	private _fire(eventName: string, data?: any) {
		const callbacks = this.callbacks[eventName];
		if (!callbacks) return;

		callbacks.slice().forEach(cb => cb(data));
	}

	private _setupPlayback() {
		let chunkIndex: number;
		let time = 0;
		for (chunkIndex = 0; chunkIndex < this._chunks.length; chunkIndex += 1) {
			const chunk = this._chunks[chunkIndex];

			if (!chunk.duration) {
				warn(`attempted to play content that has not yet buffered ${this.url}`);
				setTimeout(() => {
					this._setupPlayback();
				}, 100);
				return;
			}

			const chunkEnd = time + chunk.duration;
			if (chunkEnd > this._currentTime) break;

			time = chunkEnd;
		}

		this._startTime = this._currentTime;
		const timeOffset = this._currentTime - time;

		this._fire('play');

		let playing = true;
		const pauseListener = this.on('pause', () => {
			playing = false;

			if (this._currentSource) {
				this._currentSource.stop()
				this._currentSource.disconnect()
				this._currentSource = null;
			};
			if (this._nextSource) {
				this._nextSource.disconnect()
				this._nextSource = null;
			};
			pauseListener.cancel();
		});

		const i = chunkIndex++ % this._chunks.length;

		let chunk = this._chunks[i];

		chunk.createBufferCallback(
			decoded => {
				const source = this.context.createBufferSource();
				source.buffer = decoded;

				this._nextSource = source;

				this._contextTimeAtStart = this.context.currentTime;

				let lastStart = this._contextTimeAtStart;
				let nextStart =
					this._contextTimeAtStart + (chunk.duration! - timeOffset);

				const gain = this.context.createGain();
				gain.connect(this._gain);
				gain.gain.setValueAtTime(0, nextStart + OVERLAP);

				source.connect(gain);
				source.start(this.context.currentTime, timeOffset);
				this._actualPlaying = true;

				const endGame = () => {
					if (this.context.currentTime >= nextStart) {
						this.pause()._currentTime = 0;
						this.ended = true;
						this._fire('ended');
					} else {
						requestAnimationFrame(endGame);
					}
				};

				const advance = () => {
					if (!playing) return;

					let i = chunkIndex++;
					if (this.loop) i %= this._chunks.length;

					chunk = this._chunks[i];

					if (chunk) {
						chunk.createBufferCallback(
							decoded => {
								const source = this.context.createBufferSource();
								source.buffer = decoded;

								this._currentSource?.stop();
								this._currentSource?.disconnect();
								this._currentSource = this._nextSource;
								this._nextSource = source;

								const gain = this.context.createGain();
								gain.connect(this._gain);
								gain.gain.setValueAtTime(0, nextStart);
								gain.gain.setValueAtTime(1, nextStart + OVERLAP);

								source.connect(gain);
								source.start(nextStart);

								lastStart = nextStart;
								nextStart += chunk.duration!;

								gain.gain.setValueAtTime(0, nextStart + OVERLAP);

								tick();
							},
							(error: any) => {
								error.url = this.url;
								error.phonographCode = 'COULD_NOT_CREATE_SOURCE';
								this._fire('playbackerror', error);
							}
						);
					} else {
						endGame();
					}
				};

				const tick = () => {
					if (this.context.currentTime > lastStart) {
						advance();
					} else {
						setTimeout(tick, 500);
					}
				};

				const frame = () => {
					if (!playing) return;
					requestAnimationFrame(frame);

					this._fire('progress');
				};

				tick();
				frame();
			},
			(error: any) => {
				error.url = this.url;
				error.phonographCode = 'COULD_NOT_START_PLAYBACK';
				this._fire('playbackerror', error);
			}
		);
	}

	// Attempt to setup AudioBufferCache if it is not setup
	// Should be called when new chunk is ready
	private trySetupAudioBufferCache() {
		if (this._audioBufferCache !== null) {
			return
		}
		let lastChunk: Chunk<Metadata> | null = null;
		let chunk: Chunk<Metadata> | null = this._chunks[0] ?? null;
		let time = 0;
		while (chunk !== null) {
			if (chunk.duration === null) {
				return
			}
			const chunkEnd = time + chunk.duration;
			if (chunkEnd > this._currentTime) {
				this._audioBufferCache = {
					currentChunk: chunk,
					currentBuffer: null,
					nextBuffer: null,
					pendingBuffer: null,
				}
				// TODO: start buffer load here
				return
			};
			time = chunkEnd;
			lastChunk = chunk;
			chunk = lastChunk.next;
		}
		// All available Chunk visited, check if there are more chunks to be load.
		if(lastChunk?.ready){
			this._audioBufferCache = {
				currentChunk: null,
				currentBuffer: null,
				nextBuffer: null,
				pendingBuffer: null,
			}
		}
	}

	// Check is there enough audio buffer to schedule current and next chunk
	private audioBufferCacheHit() {
		const audioBufferCache=this._audioBufferCache
		if(audioBufferCache===null){
			return false;
		}
		const {
			currentChunk,
			currentBuffer,
			nextBuffer,
		}=audioBufferCache
		if(currentChunk===null){
			return true;
		}
		if(!currentChunk.ready){
			return false;
		}
		if(currentBuffer===null){
			return false;
		}
		const nextChunk=currentChunk.next;
		if(nextChunk===null){
			return true;
		}
		if(!nextChunk.ready){
			return false;
		}
		if(nextBuffer===null){
			return false;
		}
		return true;
	}
}
