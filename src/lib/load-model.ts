/**
 * Browser/worker-side loading of the trained weights.
 *
 * The engine does no I/O, which is what lets the same detector code run in the
 * Web Worker, in `bun test` and in every headless script. Loading happens here
 * at the edge; scripts/lib/load-model.ts is the Node/Bun twin.
 *
 * The weights are served as a static asset from public/models/. There is no
 * API call, no key and no network dependency beyond the app's own origin — the
 * simulation must keep working offline.
 */
import { decodeWeights, TinyBeaconNet, type ModelManifest } from '@/engine/nn';
import { TrackVerifier, type TrackVerifierWeights } from '@/engine/track-verifier';
import type { LoadedModel } from '@/engine/detector-ai';

export const DEFAULT_MODEL = 'beacon-roi-v2';

/**
 * Absolute URL for an app asset. The simulation worker may be started from a
 * blob: URL by the bundler, where a bare '/models/x' does not resolve; the
 * origin is always the app's, so anchor every asset path to it.
 */
export function assetUrl(path: string): string {
  const origin = (globalThis as unknown as { location?: { origin?: string } }).location?.origin;
  return origin && origin !== 'null' ? new URL(path, origin).toString() : path;
}
export const DEFAULT_VERIFIER = 'track-verifier-v1';

/** The learned track verifier, or null when it is not deployed. */
async function fetchVerifier(name: string): Promise<TrackVerifier | null> {
  try {
    const res = await fetch(assetUrl(`/models/${name}.json`));
    if (!res.ok) return null;
    return new TrackVerifier((await res.json()) as TrackVerifierWeights);
  } catch {
    return null;
  }
}

let cached: Promise<LoadedModel | null> | null = null;
/** Why the last load returned null — surfaced by the worker's error message. */
export let lastLoadError: string | null = null;

/**
 * Fetch and decode the model. Resolves to null when no model is deployed —
 * callers must treat that as "the learned detectors are unavailable", never as
 * a reason to run something else and call it AI.
 */
export function loadModel(name = DEFAULT_MODEL): Promise<LoadedModel | null> {
  if (cached !== null) return cached;
  cached = (async () => {
    try {
      const [binRes, jsonRes] = await Promise.all([
        fetch(assetUrl(`/models/${name}.bin`)),
        fetch(assetUrl(`/models/${name}.json`)),
      ]);
      if (!binRes.ok || !jsonRes.ok) {
        lastLoadError = `HTTP ${binRes.status} ${binRes.url} / ${jsonRes.status} ${jsonRes.url}`;
        cached = null;
        return null;
      }
      const manifest = (await jsonRes.json()) as ModelManifest;
      const weights = decodeWeights(await binRes.arrayBuffer());
      const net = new TinyBeaconNet(weights);
      const verifier = await fetchVerifier(DEFAULT_VERIFIER);
      lastLoadError = null;
      return { net, manifest, weights, verifier };
    } catch (err) {
      lastLoadError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      cached = null;
      return null;
    }
  })();
  return cached;
}

/** Forget the cached model — used when the page wants to re-check availability. */
export function resetModelCache(): void {
  cached = null;
}

/**
 * Availability probe for the UI, so the detector selector can disable the
 * learned options instead of offering a choice that fails at run start.
 * Fetches the manifest only — the weights are left to the worker.
 */
export async function modelManifest(name = DEFAULT_MODEL): Promise<ModelManifest | null> {
  try {
    const res = await fetch(assetUrl(`/models/${name}.json`));
    if (!res.ok) return null;
    return (await res.json()) as ModelManifest;
  } catch {
    return null;
  }
}

/** Availability probe for the track verifier the hybrid detector requires. */
export async function verifierAvailable(name = DEFAULT_VERIFIER): Promise<boolean> {
  try {
    const res = await fetch(assetUrl(`/models/${name}.json`), { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}
