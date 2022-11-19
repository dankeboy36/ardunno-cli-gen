import { debug } from 'debug';
import execa from 'execa';
import { createWriteStream, promises as fs } from 'fs';
import globby from 'globby';
import type { IncomingMessage } from 'http';
import { get as httpsGet } from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import isValidPath from 'is-valid-path';
import { isAbsolute, join } from 'path';
import rimraf from 'rimraf';
import { gte, SemVer, valid } from 'semver';
import { dir } from 'tmp-promise';
import { Open } from 'unzipper';
import { URL } from 'url';
import { promisify } from 'util';

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
        isAccessibleFolder(out),
        globProtos(src),
    ]);
    if (!force && outExists) {
        throw new Error(
            `${out} already exists. Use '--force' to override output`
        );
    }
    if (!outExists) {
        try {
            await fs.mkdir(out, { recursive: true });
        } catch (err) {
            log('failed to create --out %s %O', out, err);
            throw new Error(`Failed to create '--out' ${out}: ${err}`);
        }
    }
    if (protos) {
        log('found protos %j', protos);
        return generate(src, protos, out);
    }
    const semverOrGitHub = parseSemver(src) || parseGitHub(src);
    if (!semverOrGitHub) {
        throw new Error(`Invalid <src>: ${src}`);
    }
    const gen = async (protoPath: string, dispose: () => Promise<void>) => {
        try {
            const protos = await globProtos(protoPath);
            if (!protos) {
                throw new Error(`Failed to glob in ${protoPath}`);
            }
            await generate(protoPath, protos, out);
        } finally {
            await dispose();
        }
    };
    if (typeof semverOrGitHub === 'string') {
        const { protoPath, dispose } = await download(semverOrGitHub);
        await gen(protoPath, dispose);
    } else {
        const { protoPath, dispose } = await clone(semverOrGitHub);
        await gen(protoPath, dispose);
    }
}

interface Plugin {
    readonly name: string;
    readonly options: Record<string, string | string[] | boolean | boolean[]>;
    readonly path: string;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
const TsProto: Plugin = {
    name: 'ts_proto',
    path: require.resolve('ts-proto/protoc-gen-ts_proto'),
    options: {
        outputServices: ['nice-grpc', 'generic-definitions'],
        oneof: 'unions',
        useExactTypes: false,
        paths: 'source_relative',
        esModuleInterop: true,
    },
};

function createArgs(plugin: Plugin, src: string, out: string): string[] {
    const { name, options, path } = plugin;
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
    out: string
): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const protoc = require('protoc/protoc');
    const args = [...createArgs(TsProto, src, out), ...protos];
    log('executing %s with args %j', protoc, args);
    await execa(protoc, args);
}

async function globProtos(cwd: string): Promise<string[] | undefined> {
    log('glob %s', cwd);
    if (!(await isAccessibleFolder(cwd))) {
        log('glob invalid path %s', cwd);
        return undefined;
    }
    return globby('**/*.proto', { cwd });
}

async function isAccessibleFolder(maybePath: string): Promise<boolean> {
    log('accessible %s', maybePath);
    if (!isValidPath(maybePath)) {
        log('accessible invalid path %s', maybePath);
        return false;
    }
    const path = isAbsolute(maybePath)
        ? maybePath
        : join(process.cwd(), maybePath);
    try {
        const stat = await fs.stat(path);
        const dir = stat.isDirectory();
        log('is dir %s %d', path, dir);
        return dir;
    } catch {
        log('stat failed %s', path);
        return false;
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

/**
 * (non-API)
 */
export function parseGitHub(src: string): GitHub | undefined {
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
    await execa('git', ['clone', url, path]);
    log('cloned from %s to %s', url, path);
    await execa('git', ['-C', path, 'fetch', '--all', '--tags']);
    log('fetched all from %s', url);
    await execa('git', ['-C', path, 'checkout', commit]);
    log('checked out %s from %s', commit, url);
    return {
        protoPath: join(path, 'rpc'),
        dispose: () => promisify(rimraf)(path),
    };
}

async function download(
    semver: string
): Promise<{ protoPath: string; dispose: () => Promise<void> }> {
    if (!valid(semver)) {
        log('attempted to download with invalid semver %s', semver);
        throw new Error(`invalid semver ${semver}`);
    }
    if (!canDownloadProtos(semver)) {
        log('attempted to download the asset file with semver %s', semver);
        throw new Error(`semver must be '>=0.29.0' it was ${semver}`);
    }

    const { owner, repo } = arduinoGitHub;
    const filename = `arduino-cli_${semver}_proto.zip`;
    const endpoint = `https://github.com/${owner}/${repo}/releases/download/${semver}/${filename}`;
    log('accessing protos from public endpoint %s', endpoint);
    // asset GET will result in a HTTP 302 (Redirect)
    const getLocationResp = await get(endpoint);
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
    return {
        protoPath,
        dispose: () => promisify(rimraf)(path),
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
 * (non-API)
 *
 * If the `src` argument is `<0.29.0` semver, the function returns with a `GitHub` instance.
 */
export function parseSemver(src: string): string | GitHub | undefined {
    log('parse semver %s', src);
    if (!valid(src)) {
        log('invalid semver %s', src);
        return undefined;
    }
    const semver = new SemVer(src, true);
    const version = semver.version;
    if (canDownloadProtos(semver)) {
        log('parsed semver %s is >=0.29.0', version);
        return version;
    }
    const github = {
        ...arduinoGitHub,
        commit: semver.version,
    };
    log(
        'parsed semver %s is <0.29.0. falling back to GitHub ref %j',
        version,
        github
    );
    return github;
}

/**
 * The `.proto` files were not part of the Arduino CLI release before version 0.29.0 ([`arduino/arduino-cli#1931`](https://github.com/arduino/arduino-cli/pull/1931)).
 */
function canDownloadProtos(semver: SemVer | string): boolean {
    return gte(semver, new SemVer('0.29.0'));
}

// Taken from https://github.com/microsoft/TypeScript/issues/32098#issuecomment-1212501932
type RegExpGroups<T extends string[]> =
    | (RegExpMatchArray & {
          groups?: { [name in T[number]]: string } | { [key: string]: string };
      })
    | null;
