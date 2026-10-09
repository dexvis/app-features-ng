/**
 * Feature composition and the startup sequence of provideAppFeatures():
 * feature defaults -> server config -> URL, with the full precedence chain
 * `defaults < server < localStorage < URL < runtime` checked end to end.
 */
import { TestBed } from '@angular/core/testing';
import {
  ApplicationInitStatus,
  InjectionToken,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  AppFeature,
  appFeatureDefaults,
  appFeaturePack,
  appFeatures,
  contributeClass,
  contributeValue,
  provideAppFeatures,
  withConfigDefaults,
  withoutFeatures,
  withUrlAlias,
  withUrlShorthand,
} from './features';
import { resolveRegistry } from './registry';
import { APP_FEATURE_OWNERS, CONFIG_DEFAULTS, URL_ALIASES, URL_SHORTHANDS } from './tokens';
import { ConfigService } from './config.service';
import { CommandBusService } from './command-bus.service';
import { DEFAULT_SERVER_CONFIG_URL } from './server-config.service';

const WIDGETS = new InjectionToken<Array<{ name: string }>>('spec.widgets');

class ClassWidget {
  readonly name = 'class-widget';
}

/** Collects the multi-provider values of `token` for `features`. */
function collect<T>(token: InjectionToken<T[]>, ...features: AppFeature[]): T[] {
  TestBed.configureTestingModule({ providers: appFeatures(...features).providers });
  return TestBed.inject(token);
}

describe('appFeatures composition', () => {
  it('flattens arrays, skips falsy entries, and keeps argument order', () => {
    const flag = false as boolean;
    const composed = appFeatures(
      contributeValue(WIDGETS, { name: 'a' }),
      [contributeValue(WIDGETS, { name: 'b' }), contributeValue(WIDGETS, { name: 'c' })],
      flag && contributeValue(WIDGETS, { name: 'skipped' }),
      null,
      undefined,
      appFeatures(contributeValue(WIDGETS, { name: 'd' })),
    );
    expect(collect(WIDGETS, composed).map(w => w.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('contributeClass instantiates the class through DI', () => {
    const widgets = collect(WIDGETS, contributeClass(WIDGETS, ClassWidget));
    expect(widgets[0]).toBeInstanceOf(ClassWidget);
  });

  it('the built-in with*() functions contribute to their tokens', () => {
    TestBed.configureTestingModule({
      providers: appFeatures(
        withConfigDefaults({ 'a.b': 1 }),
        withUrlAlias('data://', 'https://host/data/'),
        withUrlShorthand('file', 'open-file'),
      ).providers,
    });
    expect(TestBed.inject(CONFIG_DEFAULTS)).toEqual([{ 'a.b': 1 }]);
    expect(TestBed.inject(URL_ALIASES)).toEqual([{ prefix: 'data://', base: 'https://host/data/' }]);
    expect(TestBed.inject(URL_SHORTHANDS)).toEqual([{ param: 'file', commandType: 'open-file' }]);
  });
});

/** A widget contribution with a feature id, the way an application's with*() function builds one. */
function withWidget(name: string, variant = name): AppFeature {
  return contributeValue(WIDGETS, { name: variant }, { kind: 'widget', id: `widget:${name}` });
}

describe('feature identity', () => {
  it('installs a feature id once: a later feature with the same id replaces the earlier one in place', () => {
    const composed = appFeatures(
      withWidget('a'),
      withWidget('b'),
      contributeValue(WIDGETS, { name: 'anonymous' }),
      withWidget('a', 'a-replaced'),
    );
    expect(collect(WIDGETS, composed).map(w => w.name)).toEqual(['a-replaced', 'b', 'anonymous']);
  });

  it('dedupes across nesting levels: a pack installed twice is installed once', () => {
    const pack = () => appFeaturePack('pack', withWidget('a'), withWidget('b'));
    const composed = appFeatures(pack(), appFeatures(pack()), withWidget('c'));
    expect(collect(WIDGETS, composed).map(w => w.name)).toEqual(['a', 'b', 'c']);
  });

  it('a replaced pack takes its whole subtree with it', () => {
    const composed = appFeatures(
      appFeaturePack('pack', withWidget('old-only'), withWidget('shared', 'shared-v1')),
      appFeaturePack('pack', withWidget('shared', 'shared-v2')),
    );
    expect(collect(WIDGETS, composed).map(w => w.name)).toEqual(['shared-v2']);
  });

  it('a replaced pack no longer replaces features outside it', () => {
    const aliases = collect(URL_ALIASES, appFeatures(
      withUrlAlias('x://', 'https://standalone/'),
      appFeaturePack('pack', withUrlAlias('x://', 'https://old-pack/')),
      appFeaturePack('pack', withUrlAlias('z://', 'https://z/')),
    ));
    expect(aliases).toEqual([
      { prefix: 'x://', base: 'https://standalone/' },
      { prefix: 'z://', base: 'https://z/' },
    ]);
  });

  it('a removed pack no longer replaces features outside it', () => {
    const aliases = collect(URL_ALIASES, appFeatures(
      appFeaturePack('pack-a', withUrlAlias('x://', 'https://a/')),
      appFeaturePack('pack-b', withUrlAlias('x://', 'https://b/')),
      withoutFeatures('pack-b'),
    ));
    expect(aliases).toEqual([{ prefix: 'x://', base: 'https://a/' }]);
  });

  it('a withoutFeatures() inside a replaced or removed pack no longer applies', () => {
    const replaced = appFeatures(
      withWidget('kept'),
      appFeaturePack('pack', withoutFeatures('widget:kept'), withWidget('old')),
      appFeaturePack('pack', withWidget('new')),
    );
    expect(collect(WIDGETS, replaced).map(w => w.name)).toEqual(['kept', 'new']);

    TestBed.resetTestingModule();
    const removed = appFeatures(
      withWidget('kept'),
      appFeaturePack('pack', withoutFeatures('widget:kept')),
      withoutFeatures('pack'),
    );
    expect(collect(WIDGETS, removed).map(w => w.name)).toEqual(['kept']);
  });

  it('a pack whose later occurrence sits in a removed pack keeps its earlier occurrence', () => {
    const composed = appFeatures(
      appFeaturePack('inner', withWidget('inner-v1')),
      appFeaturePack('outer', appFeaturePack('inner', withWidget('inner-v2'))),
      withoutFeatures('outer'),
    );
    expect(collect(WIDGETS, composed).map(w => w.name)).toEqual(['inner-v1']);
  });

  it('withoutFeatures() removes features by id wherever they sit, before or after it', () => {
    const composed = appFeatures(
      appFeaturePack('built-ins', withWidget('cube'), withWidget('tabs')),
      withWidget('mine'),
      withoutFeatures('widget:cube', 'widget:mine'),
    );
    expect(collect(WIDGETS, composed).map(w => w.name)).toEqual(['tabs']);
  });

  it('withoutFeatures() removes a whole pack by its id', () => {
    const composed = appFeatures(withoutFeatures('built-ins'), appFeaturePack('built-ins', withWidget('cube')), withWidget('mine'));
    expect(collect(WIDGETS, composed).map(w => w.name)).toEqual(['mine']);
  });

  it('the built-in with*() functions carry kinds, and keyed ones an id', () => {
    expect(withUrlAlias('data://', 'https://host/').id).toBe('url-alias:data://');
    expect(withUrlShorthand('file', 'open-file').id).toBe('url-shorthand:file');
    expect(withConfigDefaults({}).id).toBeUndefined();
    expect(appFeaturePack('p').kind).toBe('pack');
    expect(appFeatureDefaults('d').kind).toBe('defaults');
    expect(appFeatures().kind).toBe('features');
  });

  it('a later alias for the same prefix replaces the earlier one', () => {
    const aliases = collect(URL_ALIASES, appFeatures(
      withUrlAlias('data://', 'https://old/'),
      withUrlAlias('other://', 'https://other/'),
      withUrlAlias('data://', 'https://new/'),
    ));
    expect(aliases).toEqual([
      { prefix: 'data://', base: 'https://new/' },
      { prefix: 'other://', base: 'https://other/' },
    ]);
  });
});

describe('resolveRegistry', () => {
  it('keeps registration order, replaces same-id entries in place, and keeps entries without an id', () => {
    const entries = [
      { id: 'a', from: 'first' },
      { id: undefined, from: 'no-id' },
      { id: 'b', from: 'first' },
      { id: 'a', from: 'second' },
    ];
    expect(resolveRegistry(entries, entry => entry.id).map(entry => `${entry.id}:${entry.from}`))
      .toEqual(['a:second', 'undefined:no-id', 'b:first']);
  });
});

describe('composition warnings (development builds)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  it('warns when two packs contribute the same feature id with different content', () => {
    provideAppFeatures(
      appFeaturePack('pack-a', withUrlAlias('data://', 'https://a/')),
      appFeaturePack('pack-b', withUrlAlias('data://', 'https://b/')),
    );
    expect(warnings()).toEqual([expect.stringContaining(`Feature 'url-alias:data://' comes from 'pack-a' and 'pack-b'`)]);
  });

  it('advises reordering or dropping a pack: withoutFeatures(<feature id>) would remove both contributions', () => {
    provideAppFeatures(
      appFeaturePack('pack-a', withUrlAlias('data://', 'https://a/')),
      appFeaturePack('pack-b', withUrlAlias('data://', 'https://b/')),
    );
    expect(warnings()[0]).toContain(`the one from 'pack-b' takes effect`);
    expect(warnings()[0]).toContain(`withoutFeatures('<pack id>')`);
  });

  it('stays quiet about the content of a removed pack', () => {
    provideAppFeatures(
      appFeaturePack('pack-a', withUrlAlias('data://', 'https://a/')),
      appFeaturePack('pack-b', withUrlAlias('data://', 'https://b/')),
      withoutFeatures('pack-b'),
    );
    expect(warnings()).toEqual([]);
  });

  it('leaves out packs that remove each other, and warns', () => {
    TestBed.configureTestingModule({
      providers: [provideAppFeatures(
        withWidget('kept'),
        appFeaturePack('pack-p', withoutFeatures('pack-q'), withWidget('p')),
        appFeaturePack('pack-q', withoutFeatures('pack-p'), withWidget('q')),
      )],
    });
    expect(TestBed.inject(WIDGETS).map(w => w.name)).toEqual(['kept']);
    expect(warnings()).toEqual([expect.stringContaining(`Packs remove each other in a cycle; these features are left out: 'pack-p'`)]);
  });

  it('stays quiet when two packs share an identical sub-feature', () => {
    const shared = () => appFeaturePack('shared', withWidget('a'), withUrlAlias('data://', 'https://same/'));
    provideAppFeatures(appFeaturePack('pack-a', shared()), appFeaturePack('pack-b', shared()));
    expect(warnings()).toEqual([]);
  });

  it('stays quiet when a pack replaces a feature of a defaults pack (the built-ins) by id', () => {
    provideAppFeatures(
      appFeatureDefaults('built-ins', withUrlAlias('data://', 'https://built-in/')),
      appFeaturePack('pack-a', withUrlAlias('data://', 'https://a/')),
    );
    expect(warnings()).toEqual([]);
  });

  it('names the application for features outside any pack', () => {
    provideAppFeatures(appFeaturePack('pack-a', withUrlAlias('data://', 'https://a/')), withUrlAlias('data://', 'https://app/'));
    expect(warnings()).toEqual([expect.stringContaining(`'pack-a' and 'the application'`)]);
  });

  it('warns about a withoutFeatures() id that matches nothing', () => {
    provideAppFeatures(withWidget('a'), withoutFeatures('widget:typo'));
    expect(warnings()).toEqual([`[AppFeatures] withoutFeatures('widget:typo') matches no feature.`]);
  });

  it('ignores a pack nested inside a pack with its own id, and warns', () => {
    TestBed.configureTestingModule({
      providers: [provideAppFeatures(
        appFeaturePack('pack', withWidget('outer'), appFeaturePack('pack', withWidget('inner'))),
      )],
    });
    expect(TestBed.inject(WIDGETS).map(w => w.name)).toEqual(['outer']);
    expect(warnings()).toEqual([`[AppFeatures] Feature 'pack' occurs inside a composition with the same id; the inner occurrence is ignored.`]);
  });

  it('records which pack contributed each value and class, except for a defaults pack', () => {
    const value = { name: 'owned' };
    const builtIn = { name: 'built-in' };
    TestBed.configureTestingModule({
      providers: [provideAppFeatures(
        appFeatureDefaults('built-ins', contributeValue(WIDGETS, builtIn)),
        appFeaturePack('pack-a', contributeValue(WIDGETS, value), contributeClass(WIDGETS, ClassWidget)),
      )],
    });
    const owners = TestBed.inject(APP_FEATURE_OWNERS);
    expect(owners.get(value)).toEqual(['pack-a']);
    expect(owners.get(ClassWidget)).toEqual(['pack-a']);
    expect(owners.has(builtIn)).toBe(false);
  });
});

describe('provideAppFeatures startup', () => {
  const KEY = 'spec.features.layered';
  const originalUrl = window.location.href;

  beforeEach(() => {
    localStorage.removeItem(KEY);
    localStorage.removeItem(`${KEY}.time`);
  });

  afterEach(() => {
    window.history.replaceState(null, '', originalUrl);
    localStorage.removeItem(KEY);
    localStorage.removeItem(`${KEY}.time`);
  });

  /**
   * Boots the test module through provideAppFeatures, answers the server
   * config request with `serverFile`, and waits for the app initializers.
   */
  async function boot(serverFile: object, ...features: AppFeature[]): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideAppFeatures(...features),
      ],
    });
    // Injecting anything creates the module and starts the initializers.
    const initStatus = TestBed.inject(ApplicationInitStatus);
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.expectOne(DEFAULT_SERVER_CONFIG_URL).flush(JSON.stringify(serverFile));
    await initStatus.donePromise;
    httpMock.verify();
  }

  it('runs feature initializers, then defaults -> server -> URL, and queues URL commands', async () => {
    window.history.replaceState(null, '', '/?file=https%3A%2F%2Fhost%2Fa.root&cmd=show-event:1');
    const seenAtFeatureInit: unknown[] = [];
    await boot(
      { startupCommands: ['open-file:https://host/server.root'] },
      withUrlShorthand('file', 'open-file'),
      {
        kind: 'initializer',
        providers: [provideAppInitializer(() => {
          // A feature initializer declares its key before the shared startup runs.
          seenAtFeatureInit.push(inject(ConfigService).declare({ key: KEY, default: 'code' }).value);
        })],
      },
      withConfigDefaults({ [KEY]: 'pack' }),
    );
    expect(seenAtFeatureInit).toEqual(['code']);
    expect(TestBed.inject(ConfigService).getConfigOrThrow(KEY).value).toBe('pack');
    expect(TestBed.inject(CommandBusService).peekStartupCommands().map(c => [c.type, c.source])).toEqual([
      ['open-file', 'server'],
      ['open-file', 'url'],
      ['show-event', 'url'],
    ]);
  });

  it('resolves defaults < server < localStorage < URL < runtime end to end', async () => {
    const declare = () => TestBed.inject(ConfigService).declare({ key: KEY, default: 'code' });

    // defaults: the pack default replaces the code default
    await boot({}, withConfigDefaults({ [KEY]: 'pack' }));
    expect(declare().value).toBe('pack');

    // server beats defaults
    TestBed.resetTestingModule();
    await boot({ userConfigs: { [KEY]: 'server' } }, withConfigDefaults({ [KEY]: 'pack' }));
    expect(declare().value).toBe('server');

    // localStorage beats server
    TestBed.resetTestingModule();
    localStorage.setItem(KEY, 'stored');
    await boot({ userConfigs: { [KEY]: 'server' } }, withConfigDefaults({ [KEY]: 'pack' }));
    expect(declare().value).toBe('stored');

    // URL beats localStorage, and is not persisted
    TestBed.resetTestingModule();
    window.history.replaceState(null, '', `/?config.${KEY}=url`);
    await boot({ userConfigs: { [KEY]: 'server' } }, withConfigDefaults({ [KEY]: 'pack' }));
    const property = declare();
    expect(property.value).toBe('url');
    expect(localStorage.getItem(KEY)).toBe('stored');

    // runtime beats URL, persists, and ends the session override
    property.value = 'runtime';
    expect(property.value).toBe('runtime');
    expect(property.hasSessionOverride).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('runtime');
  });
});
