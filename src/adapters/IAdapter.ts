export interface IAdapter<Metadata> {
  getChunkLength: (
    rawData: Uint8Array,
    metadata: Metadata,
    index?: number
  ) => number | null;
  getChunkDuration: (
    rawData: Uint8Array,
    metadata: Metadata,
    index?: number
  ) => number | null;
  getChunkMetadata: (
    rawData: Uint8Array,
    index?: number
  ) => Metadata | null;
}
