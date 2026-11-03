/** Save export/import for a host page that embeds the emulator (AlterSpace hub): the host calls window.__alterSaves. */
import { exportContainer, importContainer } from "./worker/runtime/filesystem/save-export";

let currentEmbedGameId: string | null = null;

export function setEmbedGameId(gameId: string | null): void {
    currentEmbedGameId = gameId;
}

export function installEmbedSaves(defaultGameId?: string): void {
    if (defaultGameId) currentEmbedGameId = defaultGameId;
    (window as unknown as { __alterSaves: unknown }).__alterSaves = {
        export: (targetId?: string) => {
            const id = targetId || currentEmbedGameId;
            if (!id) return Promise.resolve(null);
            return exportContainer(id);
        },
        import: (zip: Uint8Array, targetId?: string) => {
            const id = targetId || currentEmbedGameId;
            if (!id) return Promise.resolve(false);
            return importContainer(id, zip);
        },
    };
}
