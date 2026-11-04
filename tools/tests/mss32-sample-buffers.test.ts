import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    getCtrl, CTRL_STATE, STATE_PLAYING, CTRL_FLAGS, FLAG_CIRCULAR, FLAG_STREAMING,
} from "../../src/audio/audio-ring-buffer";
import { resetMssRingBuffers, hasStreamingRing } from "../../src/worker/modules/mss32/playback-engine";
import { createSampleBufferExports } from "../../src/worker/modules/mss32/sample-buffers";
import { createSampleExports } from "../../src/worker/modules/mss32/sample";
import type { MSSContext } from "../../src/worker/modules/mss32/context";
import { SMP_PLAYING, SMP_DONE } from "../../src/worker/modules/mss32/context";

let Processor: any;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installGlobal(key: string, value: unknown): void {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

let lastRegisteredSab: SharedArrayBuffer | null = null;
let lastRegisteredId: number | null = null;

beforeAll(async () => {
    installGlobal("AudioWorkletProcessor", class {
        port = { postMessage(_msg: unknown) {}, onmessage: null as any };
    });
    installGlobal("registerProcessor", (name: string, ctor: unknown) => {
        if (name === "bottleship-audio") {
            Processor = ctor;
            (globalThis as any).__bottleshipAudioProcessor = ctor;
        }
    });
    installGlobal("sampleRate", 48000);
    installGlobal("currentTime", 0);
    installGlobal("self", {
        postMessage(msg: any) {
            if (msg.type === "audio_register") {
                lastRegisteredId = msg.payload.id;
                lastRegisteredSab = msg.payload.sab;
            }
        },
    });
    await import("../../src/audio/bottleship-audio-worklet");
    if ((globalThis as any).__bottleshipAudioProcessor) {
        Processor = (globalThis as any).__bottleshipAudioProcessor;
    }
});

afterAll(() => {
    resetMssRingBuffers();
    for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function createFixture() {
    const memory = new Uint8Array(512 * 1024);
    const ctx = {
        process: {
            memory: { alloc: () => 0x1000, free: () => {} },
            getCurrentMemory: () => memory,
        },
        memory,
        samples: new Map(),
        samplesById: new Map(),
        nextSampleId: 1,
        digitalDriverHandle: 0x100,
        driverHandle: 0x100,
        driverSampleArray: 0x200,
        driverMaxSamples: 8,
        volume: 127,
        masterVolume127: 127,
        preferences: new Array(32).fill(0),
        getDriverStatus: () => 0,
    } as unknown as MSSContext;

    // Initialize slot 0 at 0x200 as SMP_FREE (1) at offset +0x08
    const view = new DataView(memory.buffer);
    view.setUint32(0x200 + 0x08, 1 /* SMP_FREE */, true);

    const sampleExports = createSampleExports(ctx);
    const bufferExports = createSampleBufferExports(ctx);

    const thunkCtx = {
        getMemory: () => memory,
        alloc: (size: number) => 0x1000,
    } as any;

    return { ctx, memory, thunkCtx, sampleExports, bufferExports };
}

describe("MSS32 Sample Buffer Streaming", () => {
    test("double buffering lifecycle: ready alternating 0, 1, -1 and consuming audio in worklet", () => {
        const { ctx, memory, thunkCtx, sampleExports, bufferExports } = createFixture();

        // 1. Allocate sample handle
        // Setup a mock sample array in memory for _AIL_allocate_sample_handle
        // Driver structure at 0x100, samples pointer at 0x100 + 0x18
        const view = new DataView(memory.buffer);
        view.setUint32(0x100 + 0x18, 0x200, true); // pSamples
        view.setUint32(0x100 + 0x1C, 8, true);     // nSamples

        const handle = sampleExports["_AIL_allocate_sample_handle@4"](thunkCtx, memory, [0x100]) as number;
        expect(handle).toBeGreaterThan(0);

        // 2. Set sample type: stereo 16-bit PCM (format=3: stereo | 16-bit)
        bufferExports["_AIL_set_sample_type@12"](thunkCtx, memory, [handle, 3, 0]);

        // 3. Set playback rate: 22050 Hz
        sampleExports["_AIL_set_sample_playback_rate@8"](thunkCtx, memory, [handle, 22050]);

        // 4. Initially, before any buffer loaded: ready should return 0 (Buffer 0 is ready)
        const ready0 = bufferExports["_AIL_sample_buffer_ready@4"](thunkCtx, memory, [handle]);
        expect(ready0).toBe(0);

        // 5. Load Buffer 0 (64KB = 16384 frames of 16-bit stereo)
        const buf0Ptr = 0x10000;
        const bufSize = 65536; // 16384 frames
        // Fill memory with non-zero audio samples
        for (let i = 0; i < bufSize; i += 2) {
            view.setInt16(buf0Ptr + i, 10000, true);
        }

        bufferExports["_AIL_load_sample_buffer@16"](thunkCtx, memory, [handle, 0, buf0Ptr, bufSize]);

        const sampleObj = ctx.samples.get(handle)!;
        expect(hasStreamingRing(sampleObj)).toBe(true);
        expect(sampleObj.isPlaying).toBe(true);
        expect(sampleObj.totalWrittenFrames).toBe(16384);
        expect(lastRegisteredSab).not.toBeNull();

        const sab = lastRegisteredSab!;
        expect(getCtrl(sab, CTRL_FLAGS) & FLAG_STREAMING).toBe(FLAG_STREAMING);
        expect(getCtrl(sab, CTRL_FLAGS) & FLAG_CIRCULAR).toBe(FLAG_CIRCULAR);
        expect(getCtrl(sab, CTRL_STATE)).toBe(STATE_PLAYING);

        // 6. With Buffer 0 loaded, Buffer 1 should now be ready
        const ready1 = bufferExports["_AIL_sample_buffer_ready@4"](thunkCtx, memory, [handle]);
        expect(ready1).toBe(1);

        // 7. Load Buffer 1 (64KB = 16384 frames)
        const buf1Ptr = 0x20000;
        for (let i = 0; i < bufSize; i += 2) {
            view.setInt16(buf1Ptr + i, 12000, true);
        }

        bufferExports["_AIL_load_sample_buffer@16"](thunkCtx, memory, [handle, 1, buf1Ptr, bufSize]);
        expect(sampleObj.totalWrittenFrames).toBe(32768);

        // 8. With both Buffer 0 and Buffer 1 loaded, neither is ready (-1)
        const readyBoth = bufferExports["_AIL_sample_buffer_ready@4"](thunkCtx, memory, [handle]);
        expect(readyBoth).toBe(-1);

        // 9. Instantiate worklet and play audio from the ring
        const processor = new Processor();
        processor.port.onmessage({ data: { type: "register", id: sampleObj.id, sab } });

        // Buffer 0 ends at frame 16384. At 48000 Hz worklet rate vs 22050 source rate,
        // each 128 worklet output frames consumes: 128 * 22050 / 48000 = 58.8 source frames.
        // To consume 16384 source frames: 16384 / 58.8 = ~279 blocks of 128 frames.
        const channels = [new Float32Array(128), new Float32Array(128)];
        for (let b = 0; b < 290; b++) {
            processor.process([], [channels], {});
        }

        // Buffer 0 has finished playing! Buffer 0 should now be ready
        const readyAfterBuf0 = bufferExports["_AIL_sample_buffer_ready@4"](thunkCtx, memory, [handle]);
        expect(readyAfterBuf0).toBe(0);

        // 10. Re-load Buffer 0 with next chunk
        bufferExports["_AIL_load_sample_buffer@16"](thunkCtx, memory, [handle, 0, buf0Ptr, bufSize]);
        expect(sampleObj.totalWrittenFrames).toBe(49152);

        // Now Buffer 0 is busy again, Buffer 1 has not yet finished (or if not yet, ready returns -1)
        // Let's play another 290 blocks to finish Buffer 1 (which was queued up to frame 32768)
        for (let b = 0; b < 290; b++) {
            processor.process([], [channels], {});
        }

        // Buffer 1 has now finished playing! Buffer 1 should be ready
        const readyAfterBuf1 = bufferExports["_AIL_sample_buffer_ready@4"](thunkCtx, memory, [handle]);
        expect(readyAfterBuf1).toBe(1);

        // 11. Ending sample cleans up
        sampleExports["_AIL_end_sample@4"](thunkCtx, memory, [handle]);
        expect(sampleObj.isPlaying).toBe(false);
        expect(sampleObj.streamBuffers).toBeUndefined();
        expect(sampleObj.totalWrittenFrames).toBeUndefined();
        expect(hasStreamingRing(sampleObj)).toBe(false);
    });
});
