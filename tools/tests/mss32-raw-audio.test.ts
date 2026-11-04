import { describe, expect, it } from "bun:test";
import { isRawAudioPath, makeRawWavInfo, decodeStreamFile } from "../../src/worker/modules/mss32/audio-decode";
import { sniffVfsStream } from "../../src/worker/modules/mss32/stream-engine";
import type { MSSContext } from "../../src/worker/modules/mss32/context";
import type { MSSStream } from "../../src/worker/modules/mss32/types";

describe("MSS32 RAW audio support", () => {
    it("identifies .raw and .pcm paths correctly", () => {
        expect(isRawAudioPath("fx\\music\\Crusader.raw")).toBe(true);
        expect(isRawAudioPath("music/caravan.RAW")).toBe(true);
        expect(isRawAudioPath("audio/track.pcm")).toBe(true);
        expect(isRawAudioPath("music/track.wav")).toBe(false);
        expect(isRawAudioPath("music/track.mp3")).toBe(false);
        expect(isRawAudioPath(null)).toBe(false);
        expect(isRawAudioPath(undefined)).toBe(false);
    });

    it("synthesizes valid WavChunkInfo for RAW audio", () => {
        const fileSize = 5757620; // e.g. Crusader.raw size
        const info = makeRawWavInfo(fileSize);
        expect(info.formatTag).toBe(1); // PCM
        expect(info.channels).toBe(2);
        expect(info.sampleRate).toBe(22050);
        expect(info.bitsPerSample).toBe(16);
        expect(info.blockAlign).toBe(4);
        expect(info.dataChunkOffset).toBe(0);
        expect(info.dataChunkSize).toBe(fileSize);
    });

    it("decodes raw PCM stream data into Float32Array", () => {
        const dummyCtx = {
            streams: new Map(),
            streamsById: new Map(),
            fileCallbacks: null,
            initialized: true,
            process: {
                getCurrentMemory: () => new Uint8Array(0x10000),
            },
        } as unknown as MSSContext;

        const numSamples = 100;
        const pcmBytes = new Uint8Array(numSamples * 2 * 2); // 100 frames, 2ch, 16bit
        const view = new DataView(pcmBytes.buffer);
        for (let i = 0; i < numSamples * 2; i++) {
            view.setInt16(i * 2, 16384, true); // 0.5 in float
        }

        const stream: MSSStream = {
            id: 1,
            handle: 0x1000,
            filename: "fx\\music\\test.raw",
            fileData: pcmBytes,
            fileFormat: "unknown",
            sampleRate: 0,
            channels: 0,
            bitsPerSample: 0,
            blockAlign: 0,
            isPlaying: false,
            isPaused: false,
            volume: 127,
            pan: 64,
            loopCount: 1,
            decodedData: null,
        };

        const result = decodeStreamFile(dummyCtx, stream);
        expect(result).toBe(true);
        expect(stream.fileFormat).toBe("wav");
        expect(stream.channels).toBe(2);
        expect(stream.sampleRate).toBe(22050);
        expect(stream.bitsPerSample).toBe(16);
        expect(stream.blockAlign).toBe(4);
        expect(stream.decodedData).not.toBeNull();
        expect(stream.decodedData!.length).toBe(numSamples * 2);
        expect(stream.decodedData![0]).toBeCloseTo(0.5, 2);
    });
});
