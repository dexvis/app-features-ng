/**
 * Feature composition: the `with*()` functions and `provideAppFeatures()`,
 * through which an application assembles itself from features and feature
 * packs.
 *
 * API shape: one contribution per `with*()` call. Plurality comes from
 * composition: `provideAppFeatures(...)` is variadic, and `appFeatures(...)`
 * packs features into bundles that ship as one function.
 *
 * Identity: a feature may carry an `id`. When the same id occurs twice, the
 * later feature replaces the earlier one at the earlier one's position, and
 * `withoutFeatures(id)` removes it. That is the precedence rule of every
 * registry built from features; `resolveRegistry()` applies it to entries
 * that are only identifiable at runtime.
 *
 * Packs: `appFeaturePack()` groups features under an id. A pack that is
 * removed or replaced takes everything inside it along: its features, and
 * its removals and replacements of features elsewhere. A pack of defaults
 * (`appFeatureDefaults()`, an application's built-ins) is meant to be
 * replaced part by part: replacing one of its features is silent, while two
 * ordinary packs contributing one id draw a development-build warning.
 */

import {
  EnvironmentProviders,
  InjectionToken,
  Provider,
  Type,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';
import { ConfigService } from './config.service';
import { ServerConfigBase, ServerConfigService } from './server-config.service';
import { UrlStartupService } from './url-startup.service';
import type { CommandHandler } from './command-bus.service';
import {
  APP_FEATURE_OWNERS,
  COMMAND_HANDLERS,
  CONFIG_DEFAULTS,
  CONFIG_STORAGE_OPTIONS,
  type ConfigStorageOptions,
  SERVER_CONFIG_OPTIONS,
  URL_ALIASES,
  URL_SHORTHANDS,
} from './tokens';

/**
 * A feature: the providers contributed by one `with*()` call, or a
 * composition of features. Closed under composition; see `appFeatures()`.
 */
export interface AppFeature {
  /**
   * What the feature contributes, for diagnostics: `'url-alias'`,
   * `'command-handler'`, ... Compositions are `'features'` (anonymous),
   * `'pack'` (with an id, see `appFeaturePack()`) or `'defaults'` (see
   * `appFeatureDefaults()`).
   */
  readonly kind: string;
  /**
   * The feature's identity. A later feature with the same id replaces this
   * one at this one's position; `withoutFeatures(id)` removes it.
   */
  readonly id?: string;
  /** The providers. For a composition: its features' providers, after replacement and removal. */
  readonly providers: Array<Provider | EnvironmentProviders>;
  /** The composed features, for compositions. The outer composition re-applies identity across them. */
  readonly features?: readonly AppFeature[];
  /** Feature ids this feature removes from the whole composition (`withoutFeatures()`). */
  readonly removes?: readonly string[];
}

/**
 * What the composition functions accept: a feature, an array of features, or
 * a falsy value (skipped), so packs can include conditional features:
 * `appFeatures(withA(), debug && withB())`.
 */
export type AppFeatureInput = AppFeature | AppFeature[] | false | null | undefined;

/** The identity of a contribution: see `AppFeature.kind` and `AppFeature.id`. */
export interface FeatureIdentity {
  kind?: string;
  id?: string;
}

/** Owner label of features that sit in no pack: the application itself. */
export const APPLICATION_FEATURE_OWNER = 'the application';

function normalizeFeatures(inputs: readonly AppFeatureInput[]): AppFeature[] {
  const features: AppFeature[] = [];
  for (const entry of inputs) {
    if (!entry) continue;
    features.push(...(Array.isArray(entry) ? entry : [entry]));
  }
  return features;
}

/**
 * The outermost pack around a feature: its id (or APPLICATION_FEATURE_OWNER
 * outside any pack), and whether it is a pack of defaults, whose features
 * are meant to be replaced and take no part in collision warnings.
 */
interface FeatureOwner {
  label: string;
  defaults: boolean;
}

const APPLICATION: FeatureOwner = { label: APPLICATION_FEATURE_OWNER, defaults: false };

/** The owner a pack gives its features, or undefined for a feature that is no pack. */
function packOwner(feature: AppFeature): FeatureOwner | undefined {
  if (feature.id === undefined) return undefined;
  if (feature.kind === 'pack') return { label: feature.id, defaults: false };
  if (feature.kind === 'defaults') return { label: feature.id, defaults: true };
  return undefined;
}

/**
 * One occurrence of a feature in the composition tree. The same feature
 * object may occur several times (a pack installed twice), so identity rules
 * work on occurrences, never on feature objects.
 */
interface FeatureNode {
  feature: AppFeature;
  /** Position in depth-first order: a node with a higher index is a later registration. */
  index: number;
  parent: FeatureNode | undefined;
  children: FeatureNode[];
  /** The outermost pack around the occurrence, or the occurrence itself when it is a pack outside any pack. */
  owner: FeatureOwner;
  /**
   * The occurrence sits inside a composition with its own id. It never takes
   * effect: replacing the enclosing composition from inside would drop the
   * replacement with the subtree it sits in.
   */
  insideItself: boolean;
}

/** All occurrences of a feature tree in depth-first order: a parent always comes before its children. */
function featureNodes(features: readonly AppFeature[]): FeatureNode[] {
  const nodes: FeatureNode[] = [];
  const visit = (feature: AppFeature, parent: FeatureNode | undefined, outerOwner: FeatureOwner | undefined): FeatureNode => {
    const owner = outerOwner ?? packOwner(feature);
    let insideItself = false;
    for (let ancestor = parent; ancestor && feature.id !== undefined; ancestor = ancestor.parent) {
      if (ancestor.feature.id === feature.id) insideItself = true;
    }
    const node: FeatureNode = { feature, index: nodes.length, parent, children: [], owner: owner ?? APPLICATION, insideItself };
    nodes.push(node);
    for (const child of feature.features ?? []) node.children.push(visit(child, node, owner));
    return node;
  };
  for (const feature of features) visit(feature, undefined, undefined);
  return nodes;
}

/**
 * The nodes that take effect, given the nodes whose removals and
 * replacements count. A node takes effect when no counted removal names its
 * id and every enclosing composition with an id takes effect and has no
 * later counted occurrence: a replaced composition keeps its position, as
 * the place where the replacement installs, and loses its whole subtree.
 */
function nodesInEffect(nodes: readonly FeatureNode[], counted: ReadonlySet<FeatureNode>): Set<FeatureNode> {
  const removedIds = new Set<string>();
  const lastIndexById = new Map<string, number>();
  for (const node of counted) {
    if (node.insideItself) continue;
    for (const id of node.feature.removes ?? []) removedIds.add(id);
    const id = node.feature.id;
    if (id !== undefined) lastIndexById.set(id, Math.max(node.index, lastIndexById.get(id) ?? -1));
  }

  const inEffect = new Set<FeatureNode>();
  const keepsSubtree = new Set<FeatureNode>();
  for (const node of nodes) {
    const id = node.feature.id;
    if (node.parent && !keepsSubtree.has(node.parent)) continue;
    if (node.insideItself || (id !== undefined && removedIds.has(id))) continue;
    inEffect.add(node);
    const replacedLater = id !== undefined && (lastIndexById.get(id) ?? -1) > node.index;
    if (!replacedLater) keepsSubtree.add(node);
  }
  return inEffect;
}

function sameNodes(a: ReadonlySet<FeatureNode>, b: ReadonlySet<FeatureNode>): boolean {
  return a.size === b.size && [...a].every(node => b.has(node));
}

/**
 * Decides which nodes take effect. The question is circular: a removal or a
 * replacement counts only when the feature that makes it takes effect, and
 * whether that feature takes effect depends on the other removals and
 * replacements. Dropping pack 'p' (`withoutFeatures('p')`, or a later pack
 * 'p') drops everything inside it: its features, and its removals and
 * replacements of features elsewhere.
 *
 * Mechanism: start from "every node counts" and recompute the nodes in
 * effect from the previous round's answer until the answer stops changing.
 * More counted nodes never put more nodes in effect, so the rounds alternate
 * between a growing and a shrinking answer and must end in a fixed point or
 * in a two-round cycle. A cycle means removals that depend on each other
 * (pack 'p' removes 'q' and 'q' removes 'p'); the nodes that take effect in
 * only one of the two rounds are left out and reported as undecided.
 */
function resolveNodesInEffect(nodes: readonly FeatureNode[]): { inEffect: Set<FeatureNode>; undecided: FeatureNode[] } {
  let previous: Set<FeatureNode> | undefined;
  let current = new Set(nodes);
  for (;;) {
    const next = nodesInEffect(nodes, current);
    if (sameNodes(next, current)) return { inEffect: next, undecided: [] };
    if (previous && sameNodes(next, previous)) {
      // `next` and `current` are the two answers of the cycle; the smaller one lies inside the larger one
      const [smaller, larger] = next.size <= current.size ? [next, current] : [current, next];
      return { inEffect: smaller, undecided: [...larger].filter(node => !smaller.has(node)) };
    }
    previous = current;
    current = next;
  }
}

/** One emitted leaf feature and the outermost pack it came from. */
interface ComposedLeaf {
  feature: AppFeature;
  owner: FeatureOwner;
}

/** One occurrence of a feature id that takes effect, with its owner. */
interface IdOccurrence {
  feature: AppFeature;
  owner: FeatureOwner;
}

/** The result of applying identity (replacement and removal) to a feature tree. */
interface Composition {
  leaves: ComposedLeaf[];
  /** Per feature id, its occurrences that take effect, in registration order. */
  occurrences: Map<string, IdOccurrence[]>;
  /** Every feature id in the tree, including the ids of dropped features. */
  knownIds: Set<string>;
  /** The ids named by removals that take effect. */
  removedIds: Set<string>;
  /** Feature ids left out because removals depend on each other in a cycle. */
  undecidedIds: Set<string>;
  /** Feature ids that occur inside a composition with the same id. */
  insideItselfIds: Set<string>;
}

/**
 * Applies the identity rule to a feature tree: decides which occurrences
 * take effect (see resolveNodesInEffect()), then walks the tree in order and
 * emits each id once, at its first occurrence that takes effect, with the
 * content of its last one.
 */
function compose(features: readonly AppFeature[]): Composition {
  const nodes = featureNodes(features);
  const { inEffect, undecided } = resolveNodesInEffect(nodes);

  const lastById = new Map<string, FeatureNode>();
  const occurrences = new Map<string, IdOccurrence[]>();
  const removedIds = new Set<string>();
  for (const node of nodes) {
    if (!inEffect.has(node)) continue;
    for (const id of node.feature.removes ?? []) removedIds.add(id);
    const id = node.feature.id;
    if (id === undefined) continue;
    lastById.set(id, node);
    const list = occurrences.get(id) ?? [];
    list.push({ feature: node.feature, owner: node.owner });
    occurrences.set(id, list);
  }

  const leaves: ComposedLeaf[] = [];
  const emittedIds = new Set<string>();
  const emit = (node: FeatureNode): void => {
    if (!inEffect.has(node)) return;
    const id = node.feature.id;
    if (id !== undefined) {
      if (emittedIds.has(id)) return;
      emittedIds.add(id);
      node = lastById.get(id) ?? node;
    }
    if (node.feature.features) {
      for (const child of node.children) emit(child);
    } else {
      leaves.push({ feature: node.feature, owner: node.owner });
    }
  };
  for (const node of nodes) {
    if (!node.parent) emit(node);
  }

  const knownIds = new Set<string>();
  for (const node of nodes) {
    if (node.feature.id !== undefined) knownIds.add(node.feature.id);
  }
  const undecidedIds = new Set<string>();
  for (const node of undecided) {
    if (node.feature.id !== undefined) undecidedIds.add(node.feature.id);
  }
  const insideItselfIds = new Set<string>();
  for (const node of nodes) {
    if (node.insideItself) insideItselfIds.add(node.feature.id!);
  }
  return { leaves, occurrences, knownIds, removedIds, undecidedIds, insideItselfIds };
}

function providersOf(composition: Composition): Array<Provider | EnvironmentProviders> {
  return composition.leaves.flatMap(leaf => leaf.feature.providers);
}

/**
 * Composes features into one feature. This is what makes feature packs
 * possible: `export function withMyPack() { return appFeatures(withA(), withB()); }`.
 * Falsy entries are skipped; provider order follows argument order. Feature
 * ids apply across the whole composition: a later feature with an id that
 * already occurred replaces the earlier one in place.
 */
export function appFeatures(...inputs: AppFeatureInput[]): AppFeature {
  const features = normalizeFeatures(inputs);
  return { kind: 'features', providers: providersOf(compose(features)), features };
}

/**
 * Composes features into a pack with an id. The id makes the pack
 * replaceable (a later pack with the same id replaces it) and removable
 * (`withoutFeatures(id)`), installing a pack twice installs it once, and
 * development builds name the pack in collision warnings. A replaced or
 * removed pack leaves nothing behind: its replacements and removals of
 * features outside it are undone too.
 *
 * ```ts
 * export function withMyExperiment(): AppFeature {
 *   return appFeaturePack('my-experiment', withA(), withB());
 * }
 * ```
 */
export function appFeaturePack(id: string, ...inputs: AppFeatureInput[]): AppFeature {
  const features = normalizeFeatures(inputs);
  return { kind: 'pack', id, providers: providersOf(compose(features)), features };
}

/**
 * Composes an application's defaults (its built-ins) into a pack with an id.
 * The pack behaves like `appFeaturePack()`, except that replacing one of its
 * features by id is the intended way to customize it: no collision warning
 * names a defaults pack, and `APP_FEATURE_OWNERS` has no entry for its
 * contributions.
 */
export function appFeatureDefaults(id: string, ...inputs: AppFeatureInput[]): AppFeature {
  const features = normalizeFeatures(inputs);
  return { kind: 'defaults', id, providers: providersOf(compose(features)), features };
}

/**
 * Removes the features with these ids from the whole composition, wherever
 * they occur: inside packs, the built-in pack of an application included.
 * Removing a pack removes everything it contributes, so the features it
 * replaced take effect again. A `withoutFeatures()` inside a pack counts only
 * while that pack is installed.
 *
 * ```ts
 * provideAppFeatures(withMyPack(), withoutFeatures('my-pack.debug-panel'))
 * ```
 */
export function withoutFeatures(...ids: string[]): AppFeature {
  return { kind: 'without', providers: [], removes: ids };
}

/**
 * Contributes one value to a multi-provider token. Use it to write an
 * application's own `with*()` functions:
 *
 * ```ts
 * export const WIDGETS = new InjectionToken<Widget[]>('my-app.widgets');
 * export function withWidget(widget: Widget): AppFeature {
 *   return contributeValue(WIDGETS, widget, { kind: 'widget', id: `widget:${widget.name}` });
 * }
 * ```
 */
export function contributeValue<T>(token: InjectionToken<T[]>, value: T, identity: FeatureIdentity = {}): AppFeature {
  return {
    kind: identity.kind ?? 'contribution',
    id: identity.id,
    providers: [{ provide: token, useValue: value, multi: true }],
  };
}

/**
 * Contributes one class, instantiated through DI, to a multi-provider token.
 * The class may `inject()` services.
 */
export function contributeClass<T>(token: InjectionToken<T[]>, implementation: Type<T>, identity: FeatureIdentity = {}): AppFeature {
  return {
    kind: identity.kind ?? 'contribution',
    id: identity.id,
    providers: [{ provide: token, useClass: implementation, multi: true }],
  };
}

/**
 * Contributes config defaults: the LOWEST tier of the config precedence
 * (defaults < server < localStorage < URL < runtime). A pack configures,
 * never locks: any other source still overrides these values.
 */
export function withConfigDefaults(defaults: Record<string, unknown>): AppFeature {
  return contributeValue(CONFIG_DEFAULTS, defaults, { kind: 'config-defaults' });
}

/** Registers a command handler on the command bus. One handler per command type: the later registration wins. */
export function withCommandHandler(handler: Type<CommandHandler>): AppFeature {
  return contributeClass(COMMAND_HANDLERS, handler, { kind: 'command-handler' });
}

/**
 * Registers a URL protocol alias, for example `withUrlAlias('data://', 'https://host/data/')`.
 * Feature id: `url-alias:<prefix>`, so a later alias for the same prefix replaces this one.
 */
export function withUrlAlias(prefix: string, base: string): AppFeature {
  return contributeValue(URL_ALIASES, { prefix, base }, { kind: 'url-alias', id: `url-alias:${prefix}` });
}

/**
 * Registers a URL query shorthand: `?<param>=<value>` queues the same
 * startup command as `?cmd=<commandType>:<value>`, built by the handler's
 * `fromUrlArg()`. Shorthands apply in registration order, before the generic
 * `?cmd=` list. Feature id: `url-shorthand:<param>`.
 *
 * ```ts
 * withUrlShorthand('file', 'open-file')   // ?file=<url> = ?cmd=open-file:<url>
 * ```
 */
export function withUrlShorthand(param: string, commandType: string): AppFeature {
  return contributeValue(URL_SHORTHANDS, { param, commandType }, { kind: 'url-shorthand', id: `url-shorthand:${param}` });
}

/**
 * Sets where the server config is fetched from and the values it is merged
 * over. One setting per application: the last `withServerConfig()` wins
 * (feature id `server-config`).
 */
export function withServerConfig<T extends object>(options: { url?: string; defaults?: T & ServerConfigBase }): AppFeature {
  return { kind: 'server-config', id: 'server-config', providers: [{ provide: SERVER_CONFIG_OPTIONS, useValue: options }] };
}

/**
 * Sets how the config registry stores the localStorage layer. One setting
 * per application: the last `withConfigStorage()` wins (feature id
 * `config-storage`).
 *
 * ```ts
 * withConfigStorage({ prefix: 'eiceye.' })   // stores 'viewer.theme' as 'eiceye.viewer.theme'
 * ```
 *
 * The prefix applies to every property the `ConfigService` creates
 * (`declare()`, `getConfigOrCreate()`, `createConfig()`). A property you
 * construct yourself and pass to `addConfig()` keeps the storage you gave it.
 */
export function withConfigStorage(options: ConfigStorageOptions): AppFeature {
  return { kind: 'config-storage', id: 'config-storage', providers: [{ provide: CONFIG_STORAGE_OPTIONS, useValue: options }] };
}

// ---------------------------------------------------------------------------
// Development-build diagnostics
// ---------------------------------------------------------------------------

/**
 * Structural equality of provider lists, for telling a repeated feature
 * from a different one with the same id. Two calls of the same `with*()`
 * function build fresh objects and fresh arrow functions, so functions
 * compare by source text; class instances (tokens) compare by identity.
 */
function sameStructure(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'function' && typeof b === 'function') return a.toString() === b.toString();
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const plain = (value: object) => {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null || Array.isArray(value);
  };
  if (!plain(a) || !plain(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(key => sameStructure((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * Collision warnings of a composition: one feature id from several packs
 * with different content (a pack of defaults replaced by id is no
 * collision), removals that match nothing, removals that depend on each
 * other in a cycle, and a feature id nested inside itself.
 */
function collisionWarnings(composition: Composition): string[] {
  const warnings: string[] = [];
  for (const [id, occurrences] of composition.occurrences) {
    const list = occurrences.filter(occurrence => !occurrence.owner.defaults);
    const owners = [...new Set(list.map(occurrence => occurrence.owner.label))];
    if (owners.length < 2) continue;
    const kept = list[list.length - 1];
    const differs = list.some(occurrence => !sameStructure(occurrence.feature.providers, kept.feature.providers));
    if (!differs) continue;
    // withoutFeatures(id) would remove every contribution with this id, so the advice names packs
    warnings.push(`Feature '${id}' comes from ${owners.map(owner => `'${owner}'`).join(' and ')} with different content; ` +
      `the one from '${kept.owner.label}' takes effect. To keep another one, change the order of the packs ` +
      `or drop a pack with withoutFeatures('<pack id>').`);
  }
  for (const id of composition.removedIds) {
    if (!composition.knownIds.has(id)) {
      warnings.push(`withoutFeatures('${id}') matches no feature.`);
    }
  }
  if (composition.undecidedIds.size > 0) {
    const ids = [...composition.undecidedIds].map(id => `'${id}'`).join(', ');
    warnings.push(`Packs remove each other in a cycle; these features are left out: ${ids}.`);
  }
  for (const id of composition.insideItselfIds) {
    warnings.push(`Feature '${id}' occurs inside a composition with the same id; the inner occurrence is ignored.`);
  }
  return warnings;
}

/**
 * Maps each contributed value and class to the packs that contributed it, so
 * registries can name packs in their own collision warnings (two packs
 * registering the same piece type, for example). Contributions of a pack of
 * defaults have no entry: replacing them is no collision.
 */
function contributionOwners(composition: Composition): Map<unknown, string[]> {
  const owners = new Map<unknown, string[]>();
  const add = (contribution: unknown, owner: string) => {
    if (contribution === null || (typeof contribution !== 'object' && typeof contribution !== 'function')) return;
    const list = owners.get(contribution) ?? [];
    if (!list.includes(owner)) list.push(owner);
    owners.set(contribution, list);
  };
  for (const { feature, owner: { label: owner, defaults } } of composition.leaves) {
    if (defaults) continue;
    for (const provider of feature.providers) {
      if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) continue;
      const record = provider as { useValue?: unknown; useClass?: unknown };
      add(record.useValue, owner);
      add(record.useClass, owner);
    }
  }
  return owners;
}

/**
 * Assembles an application from features and adds the startup sequence.
 *
 * ```ts
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideZonelessChangeDetection(),
 *     provideHttpClient(withFetch()),
 *     provideAppFeatures(
 *       withServerConfig({ defaults: { apiBaseUrl: '' } }),
 *       withUrlShorthand('file', 'open-file'),
 *       withCommandHandler(OpenFileCommandHandler),
 *     ),
 *   ],
 * };
 * ```
 *
 * Feature identity applies across all arguments (see `appFeatures()`). In
 * development builds, a feature id that comes from two packs with different
 * content, a `withoutFeatures()` id that matches nothing, packs that remove
 * each other, and a pack nested inside a pack with its own id log an
 * `[AppFeatures]` warning.
 *
 * Startup order inside the app initializer (after the initializers that
 * features contribute):
 * 1. Apply feature-contributed config defaults.
 * 2. Load the server config (server tier of the config precedence).
 * 3. Parse URL query parameters: `config.*` session overrides and startup
 *    commands (shorthands and `?cmd=`). Commands are queued and run by the
 *    page that calls `CommandBusService.runStartupCommands()`.
 *
 * Requires `HttpClient` (`provideHttpClient()`).
 */
export function provideAppFeatures(...inputs: AppFeatureInput[]): EnvironmentProviders {
  const composition = compose(normalizeFeatures(inputs));
  const devMode = typeof ngDevMode !== 'undefined' && !!ngDevMode;
  if (devMode) {
    for (const warning of collisionWarnings(composition)) {
      console.warn(`[AppFeatures] ${warning}`);
    }
  }
  return makeEnvironmentProviders([
    ...providersOf(composition),
    // Production builds skip the owner map: only development warnings read it
    { provide: APP_FEATURE_OWNERS, useValue: devMode ? contributionOwners(composition) : new Map() },
    provideAppInitializer(async () => {
      // All injections happen BEFORE any await: the injection context does
      // not survive across async boundaries (NG0203).
      const configService = inject(ConfigService);
      const defaultsList = inject(CONFIG_DEFAULTS, { optional: true }) ?? [];
      const serverConfig = inject(ServerConfigService);
      const urlStartup = inject(UrlStartupService);

      for (const defaults of defaultsList) {
        configService.applyFeatureDefaults(defaults);
      }

      await serverConfig.loadConfig();

      urlStartup.parseCurrentUrl();
    }),
  ]);
}
