import {
  type BuilderRegistrySnapshot,
  sourceReference,
} from "./builder-registry-schema.js";
import type { SecretSource } from "./native-build-secret-models.js";
import {
  type NativeBuildState,
  unresolvedRecovery,
} from "./native-build-state.js";

/** Full desired + unresolved recovery inventory. Never call with an invalid desired snapshot.
 * Retained sources share an enabled entry's revision, or use revision 0 when none covers them.
 * Disabled entries never select a recovery revision, even when their source still matches. */
export const neededNativeSources = (
  desired: BuilderRegistrySnapshot,
  state?: NativeBuildState,
): SecretSource[] => {
  const sources: SecretSource[] = desired.builders
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      builderId: entry.id,
      source: sourceReference(entry.secretSource),
      revision: entry.secretRevision,
      retained: false,
    }));
  const saved = state?.snapshot();
  for (const job of saved?.jobs.filter(unresolvedRecovery) ?? []) {
    const generation = saved?.generations.find(
      (entry) => entry.id === job.generationId,
    );
    if (!generation) continue;
    const current = desired.builders.find(
      (entry) =>
        entry.enabled &&
        sourceReference(entry.secretSource) === generation.transport.source,
    );
    sources.push({
      builderId: job.builderId,
      source: generation.transport.source,
      revision: current?.secretRevision ?? 0,
      retained: true,
    });
  }
  const distinct = new Map<string, SecretSource>();
  for (const source of sources) {
    const key = `${source.source}@${source.revision}`;
    const existing = distinct.get(key);
    distinct.set(
      key,
      existing
        ? { ...existing, retained: existing.retained || source.retained }
        : source,
    );
  }
  return [...distinct.values()];
};
