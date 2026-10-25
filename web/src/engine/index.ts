import init, { Show, channelName } from "./pkg/lsa_wasm";

export type Vehicle = "model-s" | "model-x" | "model-3y" | "cybertruck";

export const VEHICLES: { id: Vehicle; label: string }[] = [
  { id: "model-3y", label: "Model 3 / Y" },
  { id: "model-s", label: "Model S" },
  { id: "model-x", label: "Model X" },
  { id: "cybertruck", label: "Cybertruck" },
];

let ready: Promise<unknown> | undefined;

/** Loads the WebAssembly engine once. */
export function loadEngine(): Promise<unknown> {
  ready ??= init();
  return ready;
}

export { Show, channelName };
