import { describe, test, expect } from "bun:test";
import { computePitch, normalizeSurfaceDesc } from "../../src/worker/modules/ddraw/structs";

describe("DirectDraw pitch calculation and alignment", () => {
    test("computePitch produces DWORD (4-byte) aligned row pitch", () => {
        // 8 bpp: 1 byte per pixel
        expect(computePitch(1, 8)).toBe(4);
        expect(computePitch(2, 8)).toBe(4);
        expect(computePitch(3, 8)).toBe(4);
        expect(computePitch(4, 8)).toBe(4);
        expect(computePitch(5, 8)).toBe(8);

        // 16 bpp: 2 bytes per pixel
        expect(computePitch(1, 16)).toBe(4);
        expect(computePitch(2, 16)).toBe(4);
        expect(computePitch(3, 16)).toBe(8);
        expect(computePitch(800, 16)).toBe(1600);
        expect(computePitch(1024, 16)).toBe(2048);

        // Stronghold Crusader HD world map surface (4056x2076 @ 16bpp):
        // 4056 * 2 = 8112 bytes (0x1fb0).
        // The game hardcodes 0x1fb0 as scanline stride in its software renderer.
        // DirectDraw DWORD alignment must yield exactly 8112 (not 32-byte aligned 8128).
        expect(computePitch(4056, 16)).toBe(8112);
    });

    test("normalizeSurfaceDesc computes DWORD-aligned pitch for offscreen surfaces", () => {
        const desc = normalizeSurfaceDesc(
            {
                width: 4056,
                height: 2076,
                caps: 0x840, // DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY
                pixelFormat: {
                    bpp: 16,
                    flags: 0x40, // DDPF_RGB
                    rMask: 0xf800,
                    gMask: 0x07e0,
                    bMask: 0x001f,
                    aMask: 0,
                },
            },
            800,
            600,
            16
        );

        expect(desc.width).toBe(4056);
        expect(desc.height).toBe(2076);
        expect(desc.pitch).toBe(8112);
    });
});
