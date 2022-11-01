### ardunno-cli-gen

Generates [`nice-grpc`](https://github.com/deeplay-io/nice-grpc) API from the [`.proto` files](https://github.com/arduino/arduino-cli/tree/master/rpc) of the [Arduino CLI](https://github.com/arduino/arduino-cli).

## Installation

```
npm i ardunno-cli-gen --save
```

## Usage

```
Usage: ardunno-cli generate [options] <src>

Generates TS/JS API for the Arduino CLI

Arguments:
  src                 The source of the proto files to generate from.
                      The input source can be a path to the folder
                      which contains the proto files. The source can be
                      a valid semver. Then, the proto files will be
                      downloaded from the Arduino CLI's GitHub release.
                      It can be a GitHub commit in the following format
                      `(?<owner>)/(?<repo>)(#(?<commit>))?`. Then, the
                      proto files will be cloned and checked out from
                      GitHub.

Options:
  -o, --out <string>  Specify an output folder for all emitted files.
  -f, --force         Override previously emitted files in the output
                      location.
  -h, --help          display help for command
```

Examples:

```sh
# generates from local proto files
npx ardunno-cli generate ./path/to/rpc -o ./src-gen
```

```sh
# generates from a valid semver
npx ardunno-cli generate 0.28.0 -o ./src-gen
```

```sh
# generates from the HEAD of the default branch
npx ardunno-cli generate arduino/arduino-cli -o ./src-gen
```

```sh
# generates from a specific commit
npx ardunno-cli generate arduino/arduino-cli#5a4ffe0 -o ./src-gen
```

```sh
# generates from a specific commit of a fork
npx ardunno-cli generate cmaglie/arduino-cli#alternate-homedir -o ./src-gen
```

### API

```js
const { generate } = require('ardunno-cli-gen');
(async () => {
    await generate({ src: '0.28.0', out: './src-gen', force: true });
})();
```
