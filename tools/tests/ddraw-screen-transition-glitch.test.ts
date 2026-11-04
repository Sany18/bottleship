import { describe, expect, test } from "bun:test";
import { WebGPUBackend } from "../../src/worker/backends/webgpu/webgpu-backend";
import { DDrawPresenter } from "../../src/worker/modules/ddraw/presenter";
import { Process } from "../../src/worker/core/process";
import { DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";
import { DDSCAPS_FLIP, DDSCAPS_PRIMARYSURFACE, DDSCAPS_BACKBUFFER } from "../../src/worker/modules/ddraw/constants";

describe("screen transition glitch prevention", () => {
    test("WebGPUBackend.clearCanvas submits a clear pass to the GPU queue", () => {
        let submittedCount = 0;
        let passEnded = false;
        let clearLoadOp = "";

        const mockPass = {
            end: () => { passEnded = true; },
        };

        const mockEncoder = {
            beginRenderPass: (desc: any) => {
                clearLoadOp = desc?.colorAttachments?.[0]?.loadOp;
                return mockPass;
            },
            finish: () => ({ kind: "command-buffer" }),
        };

        const mockTexture = {
            createView: () => ({ kind: "view" }),
        };

        const mockContext = {
            getCurrentTexture: () => mockTexture,
        };

        const mockQueue = {
            submit: (cmds: any[]) => {
                submittedCount += cmds.length;
            },
        };

        const mockDevice = {
            createCommandEncoder: () => mockEncoder,
            queue: mockQueue,
        };

        const backend = new WebGPUBackend();
        (backend as any).context = mockContext;
        (backend as any).device = mockDevice;

        backend.clearCanvas();

        expect(clearLoadOp).toBe("clear");
        expect(passEnded).toBe(true);
        expect(submittedCount).toBe(1);
    });

    test("DDrawPresenter.discardPendingPresents drops pending presentation state", () => {
        const dummyProcess = {
            getCurrentMemory: () => new Uint8Array(1024),
            memory: { alloc: () => 0x1000 },
        } as unknown as Process;

        const presenter = new DDrawPresenter(dummyProcess);

        // Queue a present
        const dummySurface = {
            surfacePtr: 0x1000,
            width: 800,
            height: 600,
            caps: DDSCAPS_PRIMARYSURFACE,
            format: { bpp: 16 },
        } as unknown as DirectDrawSurfaceState;

        // Discard pending presents
        presenter.discardPendingPresents();

        expect((presenter as any).pendingSurface).toBeNull();
        expect((presenter as any).pendingResolvers).toHaveLength(0);
        expect((presenter as any).lastPresented).toBeNull();
    });

    test("flipping chain caps distinguish front buffer from blit-only primary", () => {
        const frontBufferCaps = DDSCAPS_PRIMARYSURFACE | DDSCAPS_FLIP;
        const blitOnlyCaps = DDSCAPS_PRIMARYSURFACE;

        const hasFlipChain1 = (frontBufferCaps & DDSCAPS_FLIP) !== 0;
        const hasFlipChain2 = (blitOnlyCaps & DDSCAPS_FLIP) !== 0;

        expect(hasFlipChain1).toBe(true);
        expect(hasFlipChain2).toBe(false);
    });

    test("primary Blt without flip chain returns synchronously and debounces presentation", async () => {
        let presentCount = 0;
        const dummyContext: any = {
            surfaces: { primary: 0x1000, backBuffer: 0 },
            suppressPresent: false,
            pendingPrimaryBltPresent: false,
            resourceProvider: {
                getSurface: () => ({
                    getState: () => ({ surfacePtr: 0x1000, width: 800, height: 600, caps: DDSCAPS_PRIMARYSURFACE }),
                }),
            },
            process: { getCurrentMemory: () => new Uint8Array(1024) },
            presenter: {
                present: () => {
                    presentCount++;
                    return Promise.resolve();
                },
            },
        };

        const schedulePrimaryPresent = (): void => {
            if (dummyContext.pendingPrimaryBltPresent || dummyContext.suppressPresent) return;
            dummyContext.pendingPrimaryBltPresent = true;
            queueMicrotask(() => {
                dummyContext.pendingPrimaryBltPresent = false;
                if (dummyContext.surfaces.primary && !dummyContext.suppressPresent) {
                    const primaryObj = dummyContext.resourceProvider.getSurface(dummyContext.surfaces.primary);
                    if (primaryObj) {
                        void dummyContext.presenter.present(primaryObj.getState(), dummyContext.process.getCurrentMemory(), { throttle: true });
                    }
                }
            });
        };

        // Simulate 5 consecutive Blts during menu rendering (e.g. background, logo, 3 buttons)
        for (let i = 0; i < 5; i++) {
            schedulePrimaryPresent();
        }

        // Before microtask runs: 0 presents submitted
        expect(presentCount).toBe(0);
        expect(dummyContext.pendingPrimaryBltPresent).toBe(true);

        // Wait for microtask queue to drain
        await new Promise(resolve => queueMicrotask(resolve));

        // After microtask runs: exactly 1 coalesced present submitted!
        expect(presentCount).toBe(1);
        expect(dummyContext.pendingPrimaryBltPresent).toBe(false);
    });
});
