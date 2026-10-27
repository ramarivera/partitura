import { Effect, Layer } from "effect";
import { NativeBuildFiles } from "../../src/services/native-build-files.js";
import { NativeBuildProcesses } from "../../src/services/native-build-process.js";
import { createNativeBuildTransport as makeTransport } from "../../src/services/native-build-transport.js";

export * from "../../src/services/native-build-transport.js";
export const createNativeBuildTransport = (
  ...args: Parameters<typeof makeTransport>
) =>
  makeTransport(...args).pipe(
    Effect.provide(
      Layer.mergeAll(NativeBuildFiles.layer, NativeBuildProcesses.layer),
    ),
  );
