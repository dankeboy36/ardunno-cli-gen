# `ardunno-cli-gen`

Generates [`nice-grpc`](https://github.com/deeplay-io/nice-grpc) API for the [Arduino CLI](https://github.com/arduino/arduino-cli) from the [`proto` files](https://github.com/arduino/arduino-cli/tree/master/rpc)

## Installing

```
npm i ardunno-cli-gen -S
```

## Usage

### CLI

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
npx ardunno-cli generate ./path/to/rpc --out ./src-gen
```

```sh
# generates from a valid semver
npx ardunno-cli generate 0.29.0 --out ./src-gen
```

```sh
# generates from the HEAD of the default branch
npx ardunno-cli generate arduino/arduino-cli --out ./src-gen
```

```sh
# generates from a specific commit
npx ardunno-cli generate arduino/arduino-cli#5a4ffe0 --out ./src-gen
```

```sh
# generates from a specific branch of a fork
npx ardunno-cli generate cmaglie/arduino-cli#alternate-homedir --out ./src-gen
```

### API

CommonJS:

```js
const { generate } = require('ardunno-cli-gen');
```

TypeScript:

```ts
import { generate } from 'ardunno-cli-gen';
```

Generate:

```js
// `src` is a path like, a valid semver or a GitHub ref as `(?<owner>)/(?<repo>)(#(?<commit>))?`
// `out` is the output folder
// user `force` if you want to override the generated output
await generate({ src: '0.29.0', out: './src-gen', force: true });
```

## Running the tests

```
npm run test
```

## Built With

-   [`nice-grpc`](https://github.com/deeplay-io/nice-grpc) - A TypeScript gRPC library that is nice to you
-   [`ts-proto`](https://github.com/stephenh/ts-proto) - An idiomatic protobuf generator for TypeScript
-   [`protobufjs`](https://github.com/protobufjs/protobuf.js) - Protocol Buffers for JavaScript (& TypeScript)
-   [`protoc`](https://github.com/YePpHa/node-protoc) - A simple wrapper for the protoc

### Notes

-   The underlying `protoc` version is `3.20.3`. It comes from the [`protoc`](https://www.npmjs.com/package/protoc) dependency. `protoc` is not required on the `$PATH`

    ```sh
    npx protoc --version
    libprotoc 3.20.3
    ```

-   Use [`debug`](https://www.npmjs.com/package/debug) to log additional details

    ```sh
    % DEBUG=ardunno-cli* npx ardunno-cli generate ./path/to/rpc --out ./src-gen
      ardunno-cli-gen generating with {"src":"./path/to/rpc","out":"./src-gen","force":false} +0ms
      ardunno-cli-gen accessible ./src-gen +2ms
      ardunno-cli-gen glob ./path/to/rpc +1ms
      ardunno-cli-gen accessible ./path/to/rpc +1ms
    [...]
    ```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

### ⚠️ Disclaimer

The Arduino CLI has [GPL-3.0 license](https://github.com/arduino/arduino-cli/blob/master/LICENSE.txt). `ardunno-cli-gen` does not use any code from the CLI but relies on the proto files, which might conflict with the MIT License of this project. A request for a more permissive license for the proto files is still an [ongoing conversation](https://github.com/arduino/arduino-cli/issues/1957) with [Arduino](https://www.arduino.cc/). Please open a public issue if you have any concerns regarding the licensing of this project. It was made with pure ❤️

## Acknowledgments

-   [@per1234](https://github.com/per1234) for the tireless support on the [Arduino Forum](https://forum.arduino.cc/)
