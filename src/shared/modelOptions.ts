/** One entry in a provider's model picker — shared by main's discovery
 *  adapter (src/main/providerModels.ts) and the renderer's pickers. */
export interface ModelOption {
  /** undefined = use the CLI default (no --model flag) */
  id?: string;
  label: string;
}
