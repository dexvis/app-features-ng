/**
 * The precedence rule of every registry an application builds from
 * features, for entries whose id is only known at runtime (a loader's
 * `meta.id`, a command handler's `type`): entries keep registration order,
 * and a later entry with the id of an earlier one replaces it at the earlier
 * one's position. Entries without an id stay as they are.
 *
 * Feature ids follow the same rule at composition time (see features.ts).
 * This module has no imports: services and features both use it.
 *
 * ```ts
 * const loaders = resolveRegistry(inject(LOADERS, { optional: true }) ?? [], loader => loader.id);
 * ```
 */
export function resolveRegistry<T>(entries: readonly T[], idOf: (entry: T) => string | null | undefined): T[] {
  const result: T[] = [];
  const indexById = new Map<string, number>();
  for (const entry of entries) {
    const id = idOf(entry);
    if (id === null || id === undefined) {
      result.push(entry);
      continue;
    }
    const index = indexById.get(id);
    if (index === undefined) {
      indexById.set(id, result.length);
      result.push(entry);
    } else {
      result[index] = entry;
    }
  }
  return result;
}
