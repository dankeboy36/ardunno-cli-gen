import { debug } from 'debug';
import execa from 'execa';
import { promises as fs } from 'fs';
import globby from 'globby';
import isValidPath from 'is-valid-path';
import { isAbsolute, join } from 'path';
import rimraf from 'rimraf';
import { gt, SemVer, valid } from 'semver';
import { dir } from 'tmp-promise';

const log = debug('ardunno-cli-gen');

export interface Options {
    readonly src: string;
    readonly out: string;
    readonly force?: boolean;
}

export default async function (options: Options): Promise<void> {
    const { src, out, force } = options;
    log('generating with %j', options);
    const [outExists, protos] = await Promise.all([accessibleFolder(out), globProtos(src)]);
    if (!force && outExists) {
        throw new Error(`${out} already exists. Use '--force' to override output`);
    }
    if (!outExists) {
        try {
            await fs.mkdir(out, { recursive: true });
        } catch (err) {
            log('failed to create --out %O', err);
            throw new Error(`Failed to create --out: ${err}`);
        }
    }
    if (protos) {
        log('found protos %j', protos);
        return generate(src, protos, out);
    }
    let semver = parseSemver(src);
    if (typeof semver === 'string') {
        log('found semver %s', protos);
        console.warn(
            'Downloading the proto files from the GitHub release is not yet available. Falling back to Git clone. See https://github.com/arduino/arduino-cli/pull/1931.'
        );
        semver = {
            ...arduinoGitHub,
            commit: semver,
        };
        log('semver is not supported yet. falling back to GitHub %j', semver);
    }
    const gh = semver || parseGitHub(src);
    if (gh) {
        const { dispose, checkoutSrc } = await checkout(gh);
        try {
            const clonedProtos = await globProtos(checkoutSrc);
            log('cloned protos %j', clonedProtos);
            if (!clonedProtos) {
                throw new Error(`Failed to glob in ${checkoutSrc}`);
            }
            return generate(checkoutSrc, clonedProtos, out);
        } finally {
            await dispose();
        }
    }
    throw new Error(`Invalid <src>: ${src}`);
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
            (acc, [key, value]) => acc.concat((Array.isArray(value) ? value : [value]).map((v) => `${key}=${v}`)),
            [] as string[]
        )
        .join(',');
    return [`--plugin=${path}`, `--proto_path=${src}`, `--${name}_opt=${opt}`, `--${name}_out=${out}`];
}

async function generate(src: string, protos: string[], out: string): Promise<void> {
    const protoc = require('protoc/protoc');
    const args = [...createArgs(TsProto, src, out), ...protos];
    log('executing %s with args %j', protoc, args);
    await execa(protoc, args);
}

async function globProtos(cwd: string): Promise<string[] | undefined> {
    log('glob %s', cwd);
    if (!(await accessibleFolder(cwd))) {
        log('glob invalid path %s', cwd);
        return undefined;
    }
    return globby('**/*.proto', { cwd });
}

async function accessibleFolder(maybePath: string): Promise<boolean> {
    log('accessible %s', maybePath);
    if (!isValidPath(maybePath)) {
        log('accessible invalid path %s', maybePath);
        return false;
    }
    const path = isAbsolute(maybePath) ? maybePath : join(process.cwd(), maybePath);
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
const ghPattern = /^(?<owner>([0-9a-zA-Z-]+))\/(?<repo>([0-9a-zA-Z-_\.]+))(#(?<commit>([^\s]+)))?$/;
const arduinoGitHub: GitHub = {
    owner: 'arduino',
    repo: 'arduino-cli',
};

interface GitHub {
    readonly owner: string;
    readonly repo: string;
    readonly commit?: string | undefined;
}

// (non-API)
export function parseGitHub(src: string): GitHub | undefined {
    const match: RegExpGroups<['owner', 'repo', 'commit']> = src.match(ghPattern);
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

async function checkout(gh: GitHub): Promise<{ checkoutSrc: string; dispose: () => Promise<void> }> {
    const { owner, repo, commit = 'HEAD' } = gh;
    const { path } = await dir({ prefix: repo });
    log('checkout %j', gh);
    log('checkout dir %s', path);
    const url = `https://github.com/${owner}/${repo}.git`;
    await execa('git', ['clone', url, path], { stdio: 'pipe' });
    log('cloned from %s to %s', url, path);
    await execa('git', ['-C', path, 'fetch', '--all', '--tags'], { stdio: 'pipe' });
    log('fetched all from %s', url);
    await execa('git', ['-C', path, 'checkout', commit], { stdio: 'pipe' });
    log('checked out %s from %s', commit, url);
    return { checkoutSrc: join(path, 'rpc'), dispose: () => rmrf(path) };
}

async function rmrf(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => rimraf(path, (error) => (error ? reject(error) : resolve())));
}

/**
 * The `.proto` files are not part of the Arduino CLI release until before version 0.29.0+ ([`arduino/arduino-cli#1931`](https://github.com/arduino/arduino-cli/pull/1931)). It provides the GitHub ref instead.
 */
// (non-API)
export function parseSemver(src: string): string | GitHub | undefined {
    if (!valid(src)) {
        return undefined;
    }
    const semver = new SemVer(src, true);
    if (gt(semver, new SemVer('0.29.0'))) {
        return semver.version;
    }
    return {
        ...arduinoGitHub,
        commit: semver.version,
    };
}

// Taken from https://github.com/microsoft/TypeScript/issues/32098#issuecomment-1212501932
type RegExpGroups<T extends string[]> =
    | (RegExpMatchArray & { groups?: { [name in T[number]]: string } | { [key: string]: string } })
    | null;
