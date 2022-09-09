import type { IAdapter } from '../IAdapter';
import getFrameLength from './getFrameLength';
import parseFrameHeader from './parseHeader';
import parseMetadata from './parseMetadata';

import { Metadata } from './types';
import { validateHeader } from './validateHeader';

export const mp3Adapter: IAdapter<Metadata> = {
  validateChunk: validateHeader,
  getChunkLength: (rawData, metadata, index) => {
    return getFrameLength(rawData, index, metadata);
  },
  getChunkDuration: (_, metadata) => {
    return 1152 / metadata.sampleRate;
  },
  getChunkMetadata: (rawData, index) => {
      const rawMetadata = parseFrameHeader(rawData, index);

      if (!rawMetadata) return null;

      return parseMetadata(rawMetadata);
  },
}