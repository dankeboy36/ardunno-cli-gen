import debug from 'debug';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createWriteStream, promises as fs } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import { URL } from 'node:url';
import { rimraf } from 'rimraf';
import { SemVer, gte, valid } from 'semver';
import { dir } from 'tmp-promise';
import { Open } from 'unzipper';

const log = debug('ardunno-cli-gen');

export interface Options {
    readonly src: string;
    readonly out: string;
    readonly force?: boolean;
}

export default async function (options: Options): Promise<void> {
    const { src, out, force } = options;
    log('generating with options %j', options);
    const [outExists, protos] = await Promise.all([
        fs.access(out).then(
            () => true,
            () => false
        ),
        globProtos(src),
    ]);
    if (!force && outExists) {
        throw new Error(
            `${out} already exists. Use '--force' to override output`
        );
    }
    if (protos && protos.length) {
        log('found protos %j', protos);
        return generate(src, protos, out);
    }
    const semverOrGitHub = parseSemver(src) || parseGitHub(src);
    if (!semverOrGitHub) {
        throw new Error(`Invalid <src>: ${src}`);
    }
    const { protoPath, dispose } = await (semverOrGitHub instanceof SemVer
        ? download(semverOrGitHub)
        : clone(semverOrGitHub));
    try {
        const protos = await globProtos(protoPath);
        if (!protos) {
            throw new Error(`Failed to glob in ${protoPath}`);
        }
        await generate(protoPath, protos, out);
    } finally {
        await dispose();
    }
}

interface Plugin {
    readonly options: Record<string, string | string[] | boolean | boolean[]>;
    readonly path: string;
}
type PluginName = 'ts_proto';
const plugins: Record<PluginName, Plugin> = {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    ts_proto: {
        path: require.resolve('ts-proto/protoc-gen-ts_proto'),
        options: {
            outputServices: ['nice-grpc', 'generic-definitions'],
            oneof: 'unions',
            useExactTypes: false,
            paths: 'source_relative',
            esModuleInterop: true,
            exportCommonSymbols: false,
            useOptionals: 'none',
        },
    },
};

function createArgs(
    tuple: [PluginName, Plugin],
    src: string,
    out: string
): string[] {
    const [name, plugin] = tuple;
    const { options, path } = plugin;
    const opt = Object.entries(options)
        .reduce(
            (acc, [key, value]) =>
                acc.concat(
                    (Array.isArray(value) ? value : [value]).map(
                        (v) => `${key}=${v}`
                    )
                ),
            [] as string[]
        )
        .join(',');
    return [
        `--plugin=${path}`,
        `--proto_path=${src}`,
        `--${name}_opt=${opt}`,
        `--${name}_out=${out}`,
    ];
}

async function generate(
    src: string,
    protos: string[],
    out: string,
    name: PluginName = 'ts_proto'
): Promise<void> {
    try {
        await fs.mkdir(out, { recursive: true });
    } catch (err) {
        log('failed to create --out %s %O', out, err);
        throw new Error(`Failed to create '--out' ${out}: ${err}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const protoc = require('protoc/protoc'); // TODO: add support for external protoc
    const plugin = plugins[name];
    const args = [...createArgs([name, plugin], src, out), ...protos];
    log('executing %s with args %j', protoc, args);
    await execa(protoc, args);
}

async function execa(
    file: string,
    args: string[],
    options?: { cwd?: string }
): Promise<void> {
    const { execa } = await import('execa');
    await execa(file, args, options);
}

async function globProtos(cwd: string): Promise<string[] | undefined> {
    log('glob %s', cwd);
    try {
        const { globby } = await import('globby');
        const protos = await globby('**/*.proto', { cwd });
        return protos;
    } catch (err) {
        log('glob failed %O', err);
        return undefined;
    }
}

// Constraint does not match with all GitHub rules, they're only a subset of them
// owner name can contain only hyphens
// repo name can contain dots and underscores
// commit can be a branch, a hash, tag, etc, anything that git can `checkout` TODO: use https://git-scm.com/docs/git-check-ref-format?
const ghPattern =
    /^(?<owner>([0-9a-zA-Z-]+))\/(?<repo>([0-9a-zA-Z-_\.]+))(#(?<commit>([^\s]+)))?$/;
const arduinoGitHub: GitHub = {
    owner: 'arduino',
    repo: 'arduino-cli',
};

interface GitHub {
    readonly owner: string;
    readonly repo: string;
    readonly commit?: string | undefined;
}

function parseGitHub(src: string): GitHub | undefined {
    const match: RegExpGroups<['owner', 'repo', 'commit']> =
        src.match(ghPattern);
    if (match && match.groups) {
        const {
            groups: { owner, repo, commit },
        } = match;
        const gh = {
            owner,
            repo,
            ...(commit && { commit }),
        };
        log('match GitHub %s, %j', src, gh);
        return gh;
    }
    log('no match GitHub %s', src);
    return undefined;
}

async function clone(
    gh: GitHub
): Promise<{ protoPath: string; dispose: () => Promise<void> }> {
    const { owner, repo, commit = 'HEAD' } = gh;
    const { path } = await dir({ prefix: repo });
    log('clone %j', gh);
    log('clone dir %s', path);
    const url = `https://github.com/${owner}/${repo}.git`;
    try {
        await execa('git', ['clone', url, path]);
        log('cloned from %s to %s', url, path);
    } catch (err) {
        log('could not clone repository %s', url);
        throw new Error(
            `Could not clone GitHub repository from ${url}\n\nReason: ${err}`
        );
    }
    await execa('git', ['-C', path, 'fetch', '--all', '--tags']);
    log('fetched all from %s', url);
    try {
        await execa('git', ['-C', path, 'checkout', commit]);
        log('checked out %s from %s', commit, url);
    } catch (err) {
        log('could not checkout commit %s', commit);
        throw new Error(
            `Could not checkout commit '${commit}' in ${owner}/${repo}\n\nReason: ${err}`
        );
    }
    return {
        protoPath: join(path, 'rpc'),
        dispose: () => rimraf(path) as Promise<unknown> as Promise<void>,
    };
}

const { owner, repo } = arduinoGitHub;
const releases = `https://github.com/${owner}/${repo}/releases`;

function protoLocation(semver: SemVer): { endpoint: string; filename: string } {
    if (!valid(semver)) {
        log('attempted to download with invalid semver %s', semver);
        throw new Error(`invalid semver ${semver}`);
    }
    if (!canDownloadProtos(semver)) {
        log('attempted to download the asset file with semver %s', semver);
        throw new Error(`semver must be '>=0.29.0' it was ${semver}`);
    }
    const filenameVersion = semver.version;
    const ghReleaseVersion = hasSemverPrefix(semver)
        ? semver.raw
        : semver.version;
    const filename = `arduino-cli_${filenameVersion}_proto.zip`;
    const endpoint = `${releases}/download/${ghReleaseVersion}/${filename}`;
    log(
        'semver: %s (raw: %s), filename: %s, endpoint: %s',
        semver.version,
        semver.raw,
        filename,
        endpoint
    );
    return { endpoint, filename };
}

async function download(
    semver: SemVer
): Promise<{ protoPath: string; dispose: () => Promise<void> }> {
    const { endpoint, filename } = protoLocation(semver);
    log('accessing protos from public endpoint %s', endpoint);
    // asset GET will result in a HTTP 302 (Redirect)
    const getLocationResp = await get(endpoint);
    if (getLocationResp.statusCode === 404) {
        log('release is not available for semver %s', semver);
        throw new Error(
            `Could not found release for version '${semver}'. Check the release page of the Arduino CLI for available versions: ${releases}`
        );
    }
    assertStatusCode(getLocationResp.statusCode, 302);
    const location = getLocationResp.headers.location;
    if (!location) {
        log('no location header was found: %j');
        throw new Error(
            `no location header was found: ${JSON.stringify(
                getLocationResp.headers
            )}`
        );
    }

    const getAssetResp = await get(location);
    assertStatusCode(getAssetResp.statusCode, 200);
    const { path } = await dir({ prefix: repo });
    const zipPath = await new Promise<string>((resolve, reject) => {
        const out = join(path, filename);
        const file = createWriteStream(out);
        getAssetResp.pipe(file);
        file.on('finish', () =>
            file.close((err) => (err ? reject(err) : resolve(out)))
        );
        file.on('error', (err) => {
            fs.unlink(out);
            reject(err);
        });
    });
    const archive = await Open.file(zipPath);
    const protoPath = join(path, 'rpc');
    await archive.extract({ path: protoPath });
    // Patch for https://github.com/arduino/arduino-cli/issues/2755
    // Download the 1.0.4 version and use the missing google/rpc/status.proto
    if (semver.version !== '1.0.4') {
        const { protoPath: v104ProtoPath, dispose: v104Dispose } =
            await download(new SemVer('v1.0.4'));
        await fs.cp(join(v104ProtoPath, 'google'), join(protoPath, 'google'), {
            recursive: true,
        });
        v104Dispose();
    }
    return {
        protoPath,
        dispose: () => rimraf(path) as Promise<unknown> as Promise<void>,
    };
}

function assertStatusCode(actual: number | undefined, expected: number): void {
    if (actual !== expected) {
        log('unexpected status code. was %s, expected %s', actual, expected);
        throw new Error(
            `unexpected status code. was ${actual}, expected ${expected}`
        );
    }
}

async function get(endpoint: string): Promise<IncomingMessage> {
    const url = new URL(endpoint);
    const proxy = process.env.https_proxy;
    if (proxy) {
        log('using proxy %s', proxy);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (url as any).agent = new HttpsProxyAgent(proxy);
    }
    log('GET %s', url.toString());
    return new Promise((resolve) => {
        httpsGet(url, (resp) => {
            log('response %s, %s, %s', resp.statusCode, resp.method, resp.url);
            resolve(resp);
        });
    });
}

/**
 * If the `src` argument is `<0.29.0` semver, the function returns with a `GitHub` instance.
 */
function parseSemver(src: string): SemVer | GitHub | undefined {
    log('parse semver %s', src);
    if (!valid(src)) {
        log('invalid semver %s', src);
        return undefined;
    }
    const semver = new SemVer(src, { loose: true });
    if (canDownloadProtos(semver)) {
        log(
            'parsed semver %s is >=0.29.0 (raw: %s)',
            semver.version,
            semver.raw
        );
        return semver;
    }
    const github = {
        ...arduinoGitHub,
        commit: semver.version,
    };
    log(
        'parsed semver %s is <0.29.0 (raw: %s). falling back to GitHub ref %j',
        semver.version,
        semver.raw,
        github
    );
    return github;
}

/**
 * The `.proto` files were not part of the Arduino CLI release before version `0.29.0` ([`arduino/arduino-cli#1931`](https://github.com/arduino/arduino-cli/pull/1931)).
 */
function canDownloadProtos(semver: SemVer | string): boolean {
    return gte(semver, new SemVer('0.29.0'));
}

/**
 * The Arduino CLI GitHub release has the `'v'` prefix from version `>=v0.35.0-rc.1` ([`arduino/arduino-cli#2374`](https://github.com/arduino/arduino-cli/pull/2374)).
 */
function hasSemverPrefix(semver: SemVer | string): boolean {
    return gte(semver, new SemVer('0.35.0-rc.1'));
}

// Taken from https://github.com/microsoft/TypeScript/issues/32098#issuecomment-1212501932
type RegExpGroups<T extends string[]> =
    | (RegExpMatchArray & {
          groups?: { [name in T[number]]: string } | { [key: string]: string };
      })
    | null;

/**
 * (non-API)
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export const __test = {
    parseGitHub,
    protoLocation,
    parseSemver,
    execa,
} as const;
