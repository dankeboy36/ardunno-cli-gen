import * as assert from 'assert';
import execa from 'execa';
import { describe } from 'mocha';
import { join } from 'path';
import { dir as tempDir } from 'tmp-promise';
import generate, { parseGitHub, parseSemver } from '../generate';

describe('generate', () => {
    it("should fail when 'src' is an accessible file", async function () {
        await assert.rejects(
            () =>
                dir((path) =>
                    generate({
                        src: __filename,
                        out: join(path, 'src-gen'),
                    })
                ),
            {
                name: 'Error',
                message: `Invalid <src>: ${__filename}`,
            }
        );
    });

    it("should fail when '--out' exists and '--force' is not set", async () => {
        await assert.rejects(
            () =>
                dir((path) =>
                    generate({
                        src: __filename,
                        out: path,
                    })
                ),
            /^Error: .* already exists. Use '--force' to override output$/
        );
    });

    it("should fail when 'src' is unavailable semver", async function () {
        this.timeout(50_000);
        const semver = '100.200.300';
        await assert.rejects(
            () =>
                dir((path) =>
                    generate({
                        src: semver,
                        out: join(path, 'src-gen'),
                    })
                ),
            new RegExp(
                `Error: Could not found release for version '${semver}'. Check the release page of the Arduino CLI for available versions: https://github.com/arduino/arduino-cli/releases`
            )
        );
    });

    it("should fail when 'src' is a missing remote", async function () {
        this.timeout(50_000);
        const owner = '565d15d5-e7e2-46cb-b1dc-cb2bfcf1a44d';
        const repo = 'arduino-cli';
        await assert.rejects(
            () =>
                dir((path) =>
                    generate({
                        src: `${owner}/${repo}`,
                        out: join(path, 'src-gen'),
                    })
                ),
            new RegExp(
                `Error: Could not clone GitHub repository from https://github.com/${owner}/${repo}.git`
            )
        );
    });

    it("should fail when 'src' is a missing commit", async function () {
        this.timeout(50_000);
        const owner = 'dankeboy36';
        const repo = 'ctix-51';
        const commit = '565d15d5-e7e2-46cb-b1dc-cb2bfcf1a44d';
        await assert.rejects(
            () =>
                dir((path) =>
                    generate({
                        src: `${owner}/${repo}#${commit}`,
                        out: join(path, 'src-gen'),
                    })
                ),
            new RegExp(
                `Error: Could not checkout commit '${commit}' in ${owner}/${repo}`
            )
        );
    });

    it("should support 'https_proxy' environment variable", async function () {
        this.timeout(10_000);
        const invalidProxy = '300.300.300.300';
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const { https_proxy } = process.env;
        try {
            process.env.https_proxy = invalidProxy;
            await assert.rejects(
                () =>
                    dir((path) =>
                        generate({
                            src: 'arduino/arduino-cli#does-not-matter',
                            out: join(path, 'src-gen'),
                        })
                    ),
                (err) =>
                    err instanceof Error &&
                    err.message.endsWith(
                        `Could not resolve proxy: ${invalidProxy}`
                    )
            );
        } finally {
            if (typeof https_proxy === 'string') {
                process.env.https_proxy = https_proxy;
            } else {
                delete process.env.https_proxy;
            }
        }
    });

    it('should generate from local proto files', async function () {
        this.timeout(50_000);
        await dir(async (path) => {
            const out = join(path, 'src-gen');
            await generate({
                src: join(require.resolve('protoc'), '..', 'protoc', 'include'),
                out,
            });
            await execa('npm', ['link', 'protobufjs']);
            await execa('npm', ['init', '--yes'], { cwd: path });
            await execa('npm', ['link', 'protobufjs'], {
                cwd: path,
            });
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/naming-convention
                const { Empty } = require(join(
                    out,
                    'google',
                    'protobuf',
                    'empty'
                ));
                assert.notEqual(Empty, undefined);
                assert.equal(typeof Empty.fromJSON, 'function');
                assert.deepEqual(Empty.fromJSON(), {});
            } finally {
                await execa('npm', ['unlink', 'protobufjs'], {
                    cwd: path,
                });
            }
        });
    });

    describe('parseGitHub', () => {
        it('should parse valid', () => {
            assert.deepEqual(parseGitHub('arduino/arduino-cli'), {
                owner: 'arduino',
                repo: 'arduino-cli',
            });
        });
        it('should parse valid with commit', () => {
            assert.deepEqual(parseGitHub('arduino/arduino-cli#5a4ffe0'), {
                owner: 'arduino',
                repo: 'arduino-cli',
                commit: '5a4ffe0',
            });
        });
        [
            '.owner/repo',
            '_owner/repo',
            'owner/re po',
            'owner/repo#',
            '/owner/repo',
            'owner/repo/',
            'owner/repo#one two',
        ].forEach((src) =>
            it(`should not parse '${src}'`, () =>
                assert.equal(parseGitHub(src), undefined))
        );
    });
    describe('parseSemver', () => {
        it('should parse valid', () =>
            assert.equal(parseSemver('0.30.0'), '0.30.0'));
        it('should parse valid with rc', () =>
            assert.equal(parseSemver('0.30.0-rc1'), '0.30.0-rc1'));
        it("should parse valid with 'v' prefix", () =>
            assert.equal(parseSemver('v0.29.1'), '0.29.1'));
        it("should parse valid semver '>=0.29.0' as a semver [arduino/arduino-cli#1931]", () =>
            assert.equal(parseSemver('0.29.0'), '0.29.0'));
        it("should parse to GitHub ref when version is not greater than '0.28.0'", () =>
            assert.deepEqual(parseSemver('0.28.0'), {
                owner: 'arduino',
                repo: 'arduino-cli',
                commit: '0.28.0',
            }));
        ['a', '0', '0.30', '0.30.', '0.30.0.'].forEach((src) =>
            it(`should not parse '${src}'`, () =>
                assert.equal(parseSemver(src), undefined))
        );
    });
});

async function dir<T>(test: (path: string) => Promise<T>): Promise<T> {
    const { path, cleanup } = await tempDir();
    try {
        const result = await test(path);
        return result;
    } finally {
        try {
            await cleanup();
        } catch {}
    }
}
