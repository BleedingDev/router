import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript59'
import { browserConsumerTypeScriptConfiguration } from './accept-router-core-package.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

function compileConsumer(directory, source, overrides) {
  const { compilerOptions } = browserConsumerTypeScriptConfiguration()
  const converted = ts.convertCompilerOptionsFromJson(
    { ...compilerOptions, ...overrides },
    root,
  )
  assert.equal(converted.errors.length, 0)
  const file = path.join(directory, '__ssr_entrypoint_consumer__.mts')
  const host = ts.createCompilerHost(converted.options)
  const originalRead = host.readFile.bind(host)
  const originalExists = host.fileExists.bind(host)
  host.readFile = (filename) =>
    filename === file ? source : originalRead(filename)
  host.fileExists = (filename) => filename === file || originalExists(filename)
  const program = ts.createProgram([file], converted.options, host)
  return { program, diagnostics: ts.getPreEmitDiagnostics(program) }
}

function assertNoDiagnostics(diagnostics) {
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n',
    }),
  )
}

const entries = [
  {
    directory: 'router-core',
    specifier: '@tanstack/router-core/ssr/server',
    node: '@tanstack/router-core/ssr/server.node',
    portablePath: '/ssr/server',
    nodePath: '/ssr/server.node',
    formats: ['module', 'commonjs'],
  },
  {
    directory: 'start-server-core',
    specifier: '@tanstack/start-server-core',
    node: '@tanstack/start-server-core/node',
    portablePath: '/index',
    nodePath: '/index.node',
    formats: ['module'],
  },
]

for (const entry of entries) {
  const directory = path.join(root, 'packages', entry.directory)
  for (const condition of ['node', 'browser', 'workerd', 'worker']) {
    test(`${entry.specifier} resolves the ${condition} runtime entry`, () => {
      for (const format of entry.formats) {
        const node = condition === 'node'
        const extension = format === 'module' ? 'js' : 'cjs'
        const expected = `${node ? entry.nodePath : entry.portablePath}.${extension}`
        const script =
          format === 'module'
            ? `import * as api from '${entry.specifier}'; const resolved = import.meta.resolve('${entry.specifier}');`
            : `const api = require('${entry.specifier}'); const resolved = require.resolve('${entry.specifier}').replaceAll('\\\\', '/');`
        execFileSync(
          process.execPath,
          [
            `--conditions=${condition}`,
            `--input-type=${format}`,
            '--eval',
            `${script} if (!resolved.endsWith('${expected}')) throw new Error('Unexpected runtime entry: ' + resolved); if (typeof api.transformReadableStreamWithRouter !== 'function') throw new Error('Web transform missing'); ${node ? "if (typeof api.transformPipeableStreamWithRouter !== 'function') throw new Error('Node pipeable transform missing');" : ''}`,
          ],
          { cwd: directory, stdio: 'pipe' },
        )
      }
    })
  }

  for (const node of [false, true]) {
    test(`${entry.specifier} emitted ${node ? 'Node' : 'Web'} declarations support a public consumer`, () => {
      const explicit = node ? entry.node : entry.specifier
      const source = node
        ? `import { Readable } from 'node:stream';
import { transformPipeableStreamWithRouter, transformReadableStreamWithRouter } from '${explicit}';
import { transformPipeableStreamWithRouter as conditionalPipeable } from '${entry.specifier}';
declare const router: import('@tanstack/router-core').AnyRouter;
const output: Readable = transformPipeableStreamWithRouter(router, Readable.from(['<html></html>']));
const conditionalOutput: Readable = conditionalPipeable(router, Readable.from(['<html></html>']));
const web: ReadableStream<Uint8Array> = transformReadableStreamWithRouter(router, Readable.toWeb(output));
void conditionalOutput; void web;`
        : `import { transformReadableStreamWithRouter } from '${explicit}';
declare const router: import('@tanstack/router-core').AnyRouter;
const output: ReadableStream<Uint8Array> = transformReadableStreamWithRouter(router, new ReadableStream<string>());
void output;`
      const { program, diagnostics } = compileConsumer(
        directory,
        source,
        node
          ? {
              types: ['node'],
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
            }
          : {},
      )
      assertNoDiagnostics(diagnostics)
      const expected = `${node ? entry.nodePath : entry.portablePath}.d.ts`
      assert(
        program
          .getSourceFiles()
          .some((source) =>
            source.fileName
              .replaceAll('\\', '/')
              .endsWith(`/dist/esm${expected}`),
          ),
        'Must check the actual emitted public entry',
      )
      if (!node) {
        assert(
          !program
            .getSourceFiles()
            .some((source) =>
              /[/\\]@types[/\\]node[/\\]/.test(source.fileName),
            ),
          'The Web consumer must not acquire Node ambient declarations',
        )
      }
    })
  }
}

for (const framework of ['react', 'solid', 'vue']) {
  const directory = path.join(root, 'packages', framework + '-start')
  const specifier = '@tanstack/' + framework + '-start/server'
  for (const node of [false, true]) {
    test(
      specifier +
        (node
          ? ' exposes pipeable types with the Node Bundler condition'
          : ' selects the Web API with default Bundler conditions'),
      () => {
        const source = node
          ? "import { Readable } from 'node:stream';\nimport { transformPipeableStreamWithRouter } from '" +
            specifier +
            "';\ndeclare const router: Parameters<typeof transformPipeableStreamWithRouter>[0];\nconst output: Readable = transformPipeableStreamWithRouter(router, Readable.from(['<html></html>']));\nvoid output;"
          : "import { transformPipeableStreamWithRouter } from '" +
            specifier +
            "';\nvoid transformPipeableStreamWithRouter;"
        const { program, diagnostics } = compileConsumer(directory, source, {
          types: ['node'],
          customConditions: node ? ['node'] : [],
        })
        if (node) {
          assertNoDiagnostics(diagnostics)
        } else {
          assert.equal(diagnostics.length, 1)
          assert([2305, 2724].includes(diagnostics[0].code))
          assert.equal(
            diagnostics[0].file.fileName,
            path.join(directory, '__ssr_entrypoint_consumer__.mts'),
          )
          assert.equal(
            source.slice(
              diagnostics[0].start,
              diagnostics[0].start + diagnostics[0].length,
            ),
            'transformPipeableStreamWithRouter',
          )
          assert.match(
            ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n'),
            /transformPipeableStreamWithRouter/,
          )
        }
        const files = new Set(
          program
            .getSourceFiles()
            .filter((file) => file.isDeclarationFile)
            .map((file) => realpathSync(file.fileName)),
        )
        for (const declaration of [
          'packages/' + framework + '-start/dist/esm/server.d.ts',
          'packages/' + framework + '-start-server/dist/esm/index.d.ts',
          'packages/start-server-core/dist/esm/' +
            (node ? 'index.node' : 'index') +
            '.d.ts',
        ]) {
          assert(
            files.has(realpathSync(path.join(root, declaration))),
            'Must resolve current public declarations: ' + declaration,
          )
        }
      },
    )
  }
}
