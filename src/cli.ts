#!/usr/bin/env node

import { Command } from 'commander';
import generate from './generate';

const description = 'Generates TS/JS API for the Arduino CLI';
const program = new Command();
program.name('ardunno-cli').description(description);

program
    .command('generate')
    .description(description)
    .argument(
        '<src>',
        "The source of the proto files to generate from. The input source can be a path to the folder which contains the proto files. The source can be a valid semver. Then, the proto files will be downloaded from the Arduino CLI's GitHub release. It can be a GitHub commit in the following format `(?<owner>)/(?<repo>)(#(?<commit>))?`. Then, the proto files will be cloned and checked out from GitHub."
    )
    .requiredOption(
        '-o, --out <string>',
        'Specify an output folder for all emitted files.'
    )
    .option(
        '-f, --force',
        'Override previously emitted files in the output location.'
    )
    .action(async (arg, options) => {
        const src = String(arg);
        const force = Boolean(options.force);
        const out = String(options.out);
        await generate({ src, out, force });
    });

program.parse();
