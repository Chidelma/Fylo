import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import packageManifest from '../../package.json' with { type: 'json' }

const roots = []
const workspaces = []
const repoRoot = process.cwd()
const binaryPath = path.resolve(
    process.env.FYLO_BINARY ??
        path.join(repoRoot, 'dist-bin', process.platform === 'win32' ? 'fylo.exe' : 'fylo')
)
const expectedVersion = process.env.FYLO_EXPECT_BINARY_VERSION ?? packageManifest.version

/**
 * @param {string[]} args
 * @param {{ cwd?: string, stdin?: string, timeout?: number, env?: Record<string, string> }} [options]
 */
async function run(args, options = {}) {
    const proc = Bun.spawn(args, {
        cwd: options.cwd ?? repoRoot,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...options.env },
        stdin: options.stdin === undefined ? 'ignore' : new Blob([options.stdin]),
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const timeout = setTimeout(() => proc.kill(), options.timeout ?? 60_000)
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited
        ])
        return { stdout, stderr, exitCode }
    } finally {
        clearTimeout(timeout)
    }
}

/**
 * @param {string} label
 * @param {Awaited<ReturnType<typeof run>>} result
 */
function expectSuccess(label, result) {
    expect(result.exitCode, `${label} stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0)
}

/**
 * @param {string} prefix
 */
async function tempRoot(prefix) {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix))
    roots.push(root)
    return root
}

/**
 * @param {string} prefix
 */
async function tempWorkspace(prefix) {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix))
    workspaces.push(root)
    return root
}

/**
 * @param {string} command
 */
async function requireCommand(command) {
    const result = await run(['bash', '-lc', `command -v ${command}`])
    expectSuccess(`required command ${command}`, result)
}

beforeAll(async () => {
    await mkdir(path.dirname(binaryPath), { recursive: true })
    if (process.env.FYLO_SKIP_BINARY_BUILD === '1') return
    const build = await run(['bun', 'run', 'build:exe'], { timeout: 120_000 })
    expectSuccess('bun run build:exe', build)
})

afterAll(async () => {
    await Promise.all([
        ...roots.map((root) => rm(root, { recursive: true, force: true })),
        ...workspaces.map((root) => rm(root, { recursive: true, force: true }))
    ])
})

describe('compiled binary language interop', () => {
    test('compiled loop rejects array-of-object documents without partial state (#82)', async () => {
        const root = await tempRoot('fylo-binary-array-objects-')
        const requests = [
            { op: 'createCollection', collection: 'events' },
            { op: 'putData', collection: 'events', data: { kind: 'e', items: [{ a: 'b' }] } },
            { op: 'putData', collection: 'events', data: { items: [{ a: 1 }] } },
            { op: 'putData', collection: 'events', data: { state: { deep: [{ a: 'b' }] } } },
            { op: 'putData', collection: 'events', data: { items: ['plain', 'strings'] } },
            { op: 'putData', collection: 'events', data: { items: [] } },
            { op: 'putData', collection: 'events', data: { nested: { a: 'b' } } }
        ]
        const result = await run([binaryPath, 'exec', '--loop', '--root', path.join(root, 'db')], {
            stdin: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`
        })
        expectSuccess('compiled array-of-objects probe', result)

        const [, ...puts] = result.stdout.trim().split('\n').map(JSON.parse)
        for (const rejected of puts.slice(0, 3)) {
            expect(rejected.ok).toBe(false)
            expect(rejected.error.code).toBe('EARRAYOFOBJECTS')
        }
        for (const accepted of puts.slice(3)) expect(accepted.ok).toBe(true)

        // Documents live in trailing-TTID shard directories, so count the files themselves.
        const docs = await readdir(path.join(root, 'db', '.collections', 'events', 'docs'), {
            recursive: true
        })
        expect(docs.filter((entry) => entry.endsWith('.json'))).toHaveLength(3)
    })

    test('compiled CLI and loop expose the same immutable runtime identity', async () => {
        const version = await run([binaryPath, '--version'])
        expectSuccess('compiled --version', version)
        expect(version.stdout.trim()).toBe(expectedVersion)

        const cli = await run([binaryPath, 'version', '--output', 'json'])
        expectSuccess('compiled version JSON', cli)
        const cliIdentity = JSON.parse(cli.stdout)

        const loop = await run([binaryPath, 'exec', '--loop'], {
            stdin: '{"op":"handshake"}\n'
        })
        expectSuccess('compiled handshake', loop)
        const handshake = JSON.parse(loop.stdout)
        const configuredCommit = process.env.FYLO_BUILD_COMMIT ?? process.env.GITHUB_SHA ?? ''
        const releaseBuild = /^[0-9a-f]{40}$/i.test(configuredCommit)
        const expectedBuildKind =
            process.env.FYLO_EXPECT_BUILD_KIND ??
            (releaseBuild ? 'release' : 'development-compiled')
        const expectedCommit =
            process.env.FYLO_EXPECT_COMMIT ?? (releaseBuild ? configuredCommit : 'unknown')
        const expectedTarget =
            process.env.FYLO_EXPECT_TARGET ??
            `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`

        expect(handshake.protocolVersion).toBe(cliIdentity.protocolVersion)
        expect(handshake.result).toEqual(cliIdentity)
        expect(cliIdentity.runtimeVersion).toBe(expectedVersion)
        expect(cliIdentity.buildKind).toBe(expectedBuildKind)
        expect(cliIdentity.buildTarget).toBe(expectedTarget)
        expect(cliIdentity.commit).toBe(expectedCommit)
        if (cliIdentity.buildKind === 'release')
            expect(cliIdentity.commit).toMatch(/^[0-9a-f]{40}$/)
        expect(cliIdentity.dependencies.chex.requiredVersion).toBe('26.32.02')
        expect(cliIdentity.dependencies.ttid.requiredVersion).toBe('26.32.03')
        expect(cliIdentity.capabilities.documentBuckets).toEqual({
            version: 1,
            collectionKind: 'file',
            operations: [
                'createCollection',
                'dropCollection',
                'inspectCollection',
                'rebuildCollection',
                'verifyCollection',
                'getDoc',
                'getFileData',
                'getLatest',
                'getMeta',
                'setMeta',
                'findDocs',
                'findDeletedDocs',
                'restoreDoc',
                'putData',
                'patchDoc',
                'patchDocs',
                'delDoc',
                'delDocs'
            ],
            putInputs: ['path', 'url'],
            getOutputs: ['base64', 'path'],
            integrity: 'sha256-full-content'
        })
        expect(cliIdentity.capabilities.serverlessQueue).toEqual({
            version: 1,
            operations: [
                'queuePublish',
                'queueClaim',
                'queueAck',
                'queueNack',
                'queueExtend',
                'queueStats',
                'queueDeadLetters'
            ],
            storage: 'filesystem',
            broker: 'embedded',
            delivery: 'at-least-once',
            ordering: 'publication-order-claims',
            consumerGroups: true,
            visibilityLeases: true,
            delayedDelivery: true,
            idempotentPublish: true,
            deadLetters: 'per-group',
            maxMessageBytes: 1024 * 1024,
            maxClaimMessages: 1000,
            maxPendingPerGroup: 10000
        })
        if (!['darwin', 'linux'].includes(process.platform)) {
            expect(cliIdentity.capabilities.machineAccess).toBeUndefined()
        } else {
            expect(cliIdentity.capabilities.machineAccess).toEqual({
                version: 1,
                operations: [
                    'executeSQL',
                    'getDoc',
                    'getLatest',
                    'getMeta',
                    'setMeta',
                    'findDocs',
                    'findDeletedDocs',
                    'restoreDoc',
                    'joinDocs',
                    'putData',
                    'batchPutData',
                    'patchDoc',
                    'patchDocs',
                    'delDoc',
                    'delDocs',
                    'importBulkData'
                ],
                writeDescriptorFields: ['uid', 'gid', 'mode'],
                actorFields: ['uid', 'groups'],
                directDenial: 'EACCES',
                queryDenial: 'omit'
            })
        }
    })

    test('Python can drive FYLO through the machine JSON protocol', async () => {
        await requireCommand('python3')
        const root = await tempRoot('fylo-python-')
        const workspace = await tempWorkspace('fylo-python-src-')
        const script = path.join(workspace, 'interop.py')
        await writeFile(
            script,
            String.raw`import json
import subprocess
import sys

binary, root = sys.argv[1], sys.argv[2]
collection = "interop-python"

def call(request):
    completed = subprocess.run(
        [binary, "exec", "--request", json.dumps(request)],
        check=False,
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr + completed.stdout)
    payload = json.loads(completed.stdout)
    if not payload.get("ok"):
        raise RuntimeError(completed.stdout)
    return payload["result"]

call({"op": "createCollection", "root": root, "collection": collection})
doc_id = call({
    "op": "putData",
    "root": root,
    "collection": collection,
    "data": {"language": "python", "active": True, "score": 41},
})
latest = call({"op": "getLatest", "root": root, "collection": collection, "id": doc_id})
assert latest[doc_id]["language"] == "python"
found = call({
    "op": "findDocs",
    "root": root,
    "collection": collection,
    "query": {"$ops": [{"score": {"$gte": 40}}]},
})
assert found[doc_id]["active"] is True
print(json.dumps({"ok": True, "id": doc_id}))
`
        )

        const result = await run(['python3', script, binaryPath, root])
        expectSuccess('python interop', result)
        expect(existsSync(path.join(workspace, '__pycache__'))).toBe(false)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('Ruby can drive FYLO through the machine JSON protocol', async () => {
        await requireCommand('ruby')
        const root = await tempRoot('fylo-ruby-')
        const workspace = await tempWorkspace('fylo-ruby-src-')
        const script = path.join(workspace, 'interop.rb')
        await writeFile(
            script,
            String.raw`require "json"
require "open3"

binary, root = ARGV
collection = "interop-ruby"

def call(binary, request)
  stdout, stderr, status = Open3.capture3(binary, "exec", "--request", JSON.generate(request))
  raise stderr + stdout unless status.success?
  payload = JSON.parse(stdout)
  raise stdout unless payload["ok"]
  payload["result"]
end

call(binary, {"op" => "createCollection", "root" => root, "collection" => collection})
doc_id = call(binary, {
  "op" => "putData",
  "root" => root,
  "collection" => collection,
  "data" => {"language" => "ruby", "active" => true, "score" => 42}
})
latest = call(binary, {"op" => "getLatest", "root" => root, "collection" => collection, "id" => doc_id})
raise "getLatest did not round-trip Ruby document" unless latest[doc_id]["language"] == "ruby"
found = call(binary, {
  "op" => "findDocs",
  "root" => root,
  "collection" => collection,
  "query" => {"$ops" => [{"score" => {"$gte" => 40}}]}
})
raise "findDocs did not return Ruby document" unless found[doc_id]["active"] == true
puts JSON.generate({"ok" => true, "id" => doc_id})
`
        )

        const result = await run(['ruby', script, binaryPath, root])
        expectSuccess('ruby interop', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('PHP can drive FYLO through the machine JSON protocol', async () => {
        await requireCommand('php')
        const root = await tempRoot('fylo-php-')
        const workspace = await tempWorkspace('fylo-php-src-')
        const script = path.join(workspace, 'interop.php')
        await writeFile(
            script,
            String.raw`<?php
$binary = $argv[1];
$root = $argv[2];
$collection = "interop-php";

function call_fylo(string $binary, array $request): mixed {
    $pipes = [];
    $process = proc_open(
        [$binary, "exec", "--request", json_encode($request, JSON_THROW_ON_ERROR)],
        [1 => ["pipe", "w"], 2 => ["pipe", "w"]],
        $pipes
    );
    if (!is_resource($process)) {
        throw new RuntimeException("Unable to start FYLO process");
    }
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exit = proc_close($process);
    if ($exit !== 0) {
        throw new RuntimeException($stderr . $stdout);
    }
    $payload = json_decode($stdout, true, flags: JSON_THROW_ON_ERROR);
    if (($payload["ok"] ?? false) !== true) {
        throw new RuntimeException($stdout);
    }
    return $payload["result"];
}

call_fylo($binary, ["op" => "createCollection", "root" => $root, "collection" => $collection]);
$docId = call_fylo($binary, [
    "op" => "putData",
    "root" => $root,
    "collection" => $collection,
    "data" => ["language" => "php", "active" => true, "score" => 43],
]);
$latest = call_fylo($binary, ["op" => "getLatest", "root" => $root, "collection" => $collection, "id" => $docId]);
if ($latest[$docId]["language"] !== "php") {
    throw new RuntimeException("getLatest did not round-trip PHP document");
}
$found = call_fylo($binary, [
    "op" => "findDocs",
    "root" => $root,
    "collection" => $collection,
    "query" => ['$ops' => [["score" => ['$gte' => 40]]]],
]);
if ($found[$docId]["active"] !== true) {
    throw new RuntimeException("findDocs did not return PHP document");
}
echo json_encode(["ok" => true, "id" => $docId], JSON_THROW_ON_ERROR) . PHP_EOL;
`
        )

        const result = await run(['php', script, binaryPath, root])
        expectSuccess('php interop', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('Dart can drive FYLO through the machine JSON protocol', async () => {
        await requireCommand('dart')
        const root = await tempRoot('fylo-dart-')
        const workspace = await tempWorkspace('fylo-dart-src-')
        const script = path.join(workspace, 'interop.dart')
        await writeFile(
            script,
            String.raw`import 'dart:convert';
import 'dart:io';

Future<dynamic> callFylo(String binary, Map<String, dynamic> request) async {
  final result = await Process.run(binary, ['exec', '--request', jsonEncode(request)]);
  if (result.exitCode != 0) {
    throw StateError('\${result.stderr}\${result.stdout}');
  }
  final payload = jsonDecode(result.stdout as String) as Map<String, dynamic>;
  if (payload['ok'] != true) {
    throw StateError(result.stdout as String);
  }
  return payload['result'];
}

Future<void> main(List<String> args) async {
  final binary = args[0];
  final root = args[1];
  const collection = 'interop-dart';
  await callFylo(binary, {'op': 'createCollection', 'root': root, 'collection': collection});
  final docId = await callFylo(binary, {
    'op': 'putData',
    'root': root,
    'collection': collection,
    'data': {'language': 'dart', 'active': true, 'score': 44},
  }) as String;
  final latest = await callFylo(binary, {'op': 'getLatest', 'root': root, 'collection': collection, 'id': docId}) as Map<String, dynamic>;
  if ((latest[docId] as Map<String, dynamic>)['language'] != 'dart') {
    throw StateError('getLatest did not round-trip Dart document');
  }
  final found = await callFylo(binary, {
    'op': 'findDocs',
    'root': root,
    'collection': collection,
    'query': {r'$ops': [{'score': {r'$gte': 40}}]},
  }) as Map<String, dynamic>;
  if ((found[docId] as Map<String, dynamic>)['active'] != true) {
    throw StateError('findDocs did not return Dart document');
  }
  print(jsonEncode({'ok': true, 'id': docId}));
}
`
        )

        const result = await run(['dart', script, binaryPath, root], { timeout: 120_000 })
        expectSuccess('dart interop', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('Java can drive FYLO through the machine JSON protocol', async () => {
        await requireCommand('javac')
        await requireCommand('java')
        const root = await tempRoot('fylo-java-')
        const workspace = await tempWorkspace('fylo-java-src-')
        const source = path.join(workspace, 'Interop.java')
        await writeFile(
            source,
            String.raw`import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

public class Interop {
    static String escapeJson(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    static String extractResultString(String payload) {
        String marker = "\"result\":\"";
        int start = payload.indexOf(marker);
        if (start < 0) throw new IllegalStateException("missing result string: " + payload);
        start += marker.length();
        int end = payload.indexOf("\"", start);
        if (end < 0) throw new IllegalStateException("unterminated result string: " + payload);
        return payload.substring(start, end);
    }

    static String call(String binary, String request) throws IOException, InterruptedException {
        Process process = new ProcessBuilder(List.of(binary, "exec", "--request", request)).start();
        String stdout = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        String stderr = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
        int exit = process.waitFor();
        if (exit != 0) throw new IllegalStateException(stderr + stdout);
        if (!stdout.contains("\"ok\":true")) throw new IllegalStateException(stdout);
        return stdout;
    }

    public static void main(String[] args) throws Exception {
        String binary = args[0];
        String root = escapeJson(args[1]);
        String collection = "interop-java";
        call(binary, String.format("{\"op\":\"createCollection\",\"root\":\"%s\",\"collection\":\"%s\"}", root, collection));
        String put = call(binary, String.format(
            "{\"op\":\"putData\",\"root\":\"%s\",\"collection\":\"%s\",\"data\":{\"language\":\"java\",\"active\":true,\"score\":45}}",
            root,
            collection
        ));
        String id = extractResultString(put);
        String latest = call(binary, String.format(
            "{\"op\":\"getLatest\",\"root\":\"%s\",\"collection\":\"%s\",\"id\":\"%s\"}",
            root,
            collection,
            id
        ));
        if (!latest.contains("\"language\":\"java\"")) {
            throw new IllegalStateException("getLatest did not round-trip Java document: " + latest);
        }
        String found = call(binary, String.format(
            "{\"op\":\"findDocs\",\"root\":\"%s\",\"collection\":\"%s\",\"query\":{\"$ops\":[{\"score\":{\"$gte\":40}}]}}",
            root,
            collection
        ));
        if (!found.contains("\"" + id + "\":") || !found.contains("\"active\":true")) {
            throw new IllegalStateException("findDocs did not return Java document: " + found);
        }
        System.out.println("{\"ok\":true,\"id\":\"" + id + "\"}");
    }
}
`
        )
        const compile = await run(['javac', source], { timeout: 120_000 })
        expectSuccess('javac interop compile', compile)

        const result = await run(['java', '-cp', workspace, 'Interop', binaryPath, root], {
            timeout: 120_000
        })
        expectSuccess('java interop', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('C# can drive FYLO through the machine JSON protocol', async () => {
        await requireCommand('dotnet')
        const root = await tempRoot('fylo-csharp-')
        const workspace = await tempWorkspace('fylo-csharp-src-')
        await writeFile(
            path.join(workspace, 'Interop.csproj'),
            String.raw`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`
        )
        await writeFile(
            path.join(workspace, 'Program.cs'),
            String.raw`using System.Diagnostics;
using System.Text.Json;

static JsonElement CallFylo(string binary, object request)
{
    var body = JsonSerializer.Serialize(request);
    using var process = new Process();
    process.StartInfo.FileName = binary;
    process.StartInfo.ArgumentList.Add("exec");
    process.StartInfo.ArgumentList.Add("--request");
    process.StartInfo.ArgumentList.Add(body);
    process.StartInfo.RedirectStandardOutput = true;
    process.StartInfo.RedirectStandardError = true;
    process.Start();
    var stdout = process.StandardOutput.ReadToEnd();
    var stderr = process.StandardError.ReadToEnd();
    process.WaitForExit();
    if (process.ExitCode != 0) throw new Exception(stderr + stdout);
    using var document = JsonDocument.Parse(stdout);
    if (!document.RootElement.GetProperty("ok").GetBoolean()) throw new Exception(stdout);
    return document.RootElement.GetProperty("result").Clone();
}

var binary = args[0];
var root = args[1];
const string collection = "interop-csharp";
CallFylo(binary, new { op = "createCollection", root, collection });
var id = CallFylo(binary, new {
    op = "putData",
    root,
    collection,
    data = new { language = "csharp", active = true, score = 46 }
}).GetString()!;
var latest = CallFylo(binary, new { op = "getLatest", root, collection, id });
if (latest.GetProperty(id).GetProperty("language").GetString() != "csharp")
    throw new Exception("getLatest did not round-trip C# document");
var found = CallFylo(binary, new {
    op = "findDocs",
    root,
    collection,
    query = new Dictionary<string, object> {
        ["$ops"] = new object[] {
            new Dictionary<string, object> {
                ["score"] = new Dictionary<string, object> { ["$gte"] = 40 }
            }
        }
    }
});
if (!found.GetProperty(id).GetProperty("active").GetBoolean())
    throw new Exception("findDocs did not return C# document");
Console.WriteLine(JsonSerializer.Serialize(new { ok = true, id }));
`
        )

        const result = await run(
            ['dotnet', 'run', '--project', workspace, '--', binaryPath, root],
            {
                timeout: 120_000
            }
        )
        expectSuccess('csharp interop', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('C++ can drive FYLO through the machine JSON protocol', async () => {
        await requireCommand('c++')
        const root = await tempRoot('fylo-cpp-')
        const workspace = await tempWorkspace('fylo-cpp-src-')
        const source = path.join(workspace, 'interop.cpp')
        const executable = path.join(workspace, 'interop-cpp')
        await writeFile(
            source,
            String.raw`#include <array>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

std::string shell_quote(const std::string& value) {
    std::string out = "'";
    for (char ch : value) {
        if (ch == '\'') out += "'\\''";
        else out += ch;
    }
    out += "'";
    return out;
}

std::string json_escape(std::string value) {
    std::string out;
    for (char ch : value) {
        if (ch == '\\') out += "\\\\";
        else if (ch == '"') out += "\\\"";
        else out += ch;
    }
    return out;
}

std::string extract_result_string(const std::string& payload) {
    const std::string marker = "\"result\":\"";
    auto start = payload.find(marker);
    if (start == std::string::npos) throw std::runtime_error("missing result string: " + payload);
    start += marker.size();
    auto end = payload.find('"', start);
    if (end == std::string::npos) throw std::runtime_error("unterminated result string: " + payload);
    return payload.substr(start, end - start);
}

std::string call(const std::string& binary, const std::string& request) {
    std::string command = shell_quote(binary) + " exec --request " + shell_quote(request) + " 2>&1";
    std::array<char, 4096> buffer{};
    std::string output;
    FILE* pipe = popen(command.c_str(), "r");
    if (!pipe) throw std::runtime_error("failed to start FYLO binary");
    while (fgets(buffer.data(), buffer.size(), pipe) != nullptr) output += buffer.data();
    int status = pclose(pipe);
    if (status != 0) throw std::runtime_error(output);
    if (output.find("\"ok\":true") == std::string::npos) throw std::runtime_error(output);
    return output;
}

int main(int argc, char** argv) {
    std::string binary = argv[1];
    std::string root = json_escape(argv[2]);
    std::string collection = "interop-cpp";
    call(binary, "{\"op\":\"createCollection\",\"root\":\"" + root + "\",\"collection\":\"" + collection + "\"}");
    std::string put = call(binary, "{\"op\":\"putData\",\"root\":\"" + root + "\",\"collection\":\"" + collection + "\",\"data\":{\"language\":\"cpp\",\"active\":true,\"score\":47}}");
    std::string id = extract_result_string(put);
    std::string latest = call(binary, "{\"op\":\"getLatest\",\"root\":\"" + root + "\",\"collection\":\"" + collection + "\",\"id\":\"" + id + "\"}");
    if (latest.find("\"language\":\"cpp\"") == std::string::npos) throw std::runtime_error("getLatest did not round-trip C++ document");
    std::string found = call(binary, "{\"op\":\"findDocs\",\"root\":\"" + root + "\",\"collection\":\"" + collection + "\",\"query\":{\"$ops\":[{\"score\":{\"$gte\":40}}]}}");
    if (found.find("\"" + id + "\":") == std::string::npos || found.find("\"active\":true") == std::string::npos)
        throw std::runtime_error("findDocs did not return C++ document");
    std::cout << "{\"ok\":true,\"id\":\"" << id << "\"}" << std::endl;
}
`
        )
        const compile = await run(['c++', '-std=c++17', source, '-o', executable], {
            timeout: 120_000
        })
        expectSuccess('c++ interop compile', compile)

        const result = await run([executable, binaryPath, root], { timeout: 120_000 })
        expectSuccess('c++ interop', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('Swift can drive FYLO through the machine JSON protocol', async () => {
        await requireCommand('swift')
        const root = await tempRoot('fylo-swift-')
        const workspace = await tempWorkspace('fylo-swift-src-')
        const source = path.join(workspace, 'interop.swift')
        await writeFile(
            source,
            String.raw`import Foundation

func jsonEscape(_ value: String) -> String {
    value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
}

func extractResultString(_ payload: String) throws -> String {
    let marker = "\"result\":\""
    guard let range = payload.range(of: marker) else { throw NSError(domain: "Interop", code: 1) }
    let tail = payload[range.upperBound...]
    guard let end = tail.firstIndex(of: "\"") else { throw NSError(domain: "Interop", code: 2) }
    return String(tail[..<end])
}

func call(_ binary: String, _ request: String) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: binary)
    process.arguments = ["exec", "--request", request]
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    try process.run()
    process.waitUntilExit()
    let out = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let err = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    if process.terminationStatus != 0 { throw NSError(domain: err + out, code: Int(process.terminationStatus)) }
    if !out.contains("\"ok\":true") { throw NSError(domain: out, code: 3) }
    return out
}

let binary = CommandLine.arguments[1]
let root = jsonEscape(CommandLine.arguments[2])
let collection = "interop-swift"
_ = try call(binary, "{\"op\":\"createCollection\",\"root\":\"\(root)\",\"collection\":\"\(collection)\"}")
let put = try call(binary, "{\"op\":\"putData\",\"root\":\"\(root)\",\"collection\":\"\(collection)\",\"data\":{\"language\":\"swift\",\"active\":true,\"score\":48}}")
let id = try extractResultString(put)
let latest = try call(binary, "{\"op\":\"getLatest\",\"root\":\"\(root)\",\"collection\":\"\(collection)\",\"id\":\"\(id)\"}")
if !latest.contains("\"language\":\"swift\"") { throw NSError(domain: "getLatest did not round-trip Swift document", code: 4) }
let found = try call(binary, "{\"op\":\"findDocs\",\"root\":\"\(root)\",\"collection\":\"\(collection)\",\"query\":{\"$ops\":[{\"score\":{\"$gte\":40}}]}}")
if !found.contains("\"\(id)\":") || !found.contains("\"active\":true") {
    throw NSError(domain: "findDocs did not return Swift document", code: 5)
}
print("{\"ok\":true,\"id\":\"\(id)\"}")
`
        )

        const result = await run(['swift', source, binaryPath, root], { timeout: 120_000 })
        expectSuccess('swift interop', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('Kotlin can drive FYLO through the machine JSON protocol', async () => {
        await requireCommand('kotlinc')
        await requireCommand('java')
        const root = await tempRoot('fylo-kotlin-')
        const workspace = await tempWorkspace('fylo-kotlin-src-')
        const source = path.join(workspace, 'Interop.kt')
        const jar = path.join(workspace, 'interop.jar')
        await writeFile(
            source,
            String.raw`import java.io.File

fun jsonEscape(value: String): String = value.replace("\\", "\\\\").replace("\"", "\\\"")

fun extractResultString(payload: String): String {
    val marker = "\"result\":\""
    val start = payload.indexOf(marker)
    require(start >= 0) { "missing result string: $payload" }
    val valueStart = start + marker.length
    val end = payload.indexOf("\"", valueStart)
    require(end >= 0) { "unterminated result string: $payload" }
    return payload.substring(valueStart, end)
}

fun call(binary: String, request: String): String {
    val process = ProcessBuilder(binary, "exec", "--request", request).start()
    val stdout = process.inputStream.bufferedReader().readText()
    val stderr = process.errorStream.bufferedReader().readText()
    val exit = process.waitFor()
    require(exit == 0) { stderr + stdout }
    require(stdout.contains("\"ok\":true")) { stdout }
    return stdout
}

fun main(args: Array<String>) {
    val binary = args[0]
    val root = jsonEscape(args[1])
    val collection = "interop-kotlin"
    call(binary, "{\"op\":\"createCollection\",\"root\":\"$root\",\"collection\":\"$collection\"}")
    val put = call(binary, "{\"op\":\"putData\",\"root\":\"$root\",\"collection\":\"$collection\",\"data\":{\"language\":\"kotlin\",\"active\":true,\"score\":49}}")
    val id = extractResultString(put)
    val latest = call(binary, "{\"op\":\"getLatest\",\"root\":\"$root\",\"collection\":\"$collection\",\"id\":\"$id\"}")
    require(latest.contains("\"language\":\"kotlin\"")) { "getLatest did not round-trip Kotlin document: $latest" }
    val found = call(binary, "{\"op\":\"findDocs\",\"root\":\"$root\",\"collection\":\"$collection\",\"query\":{\"$" + "ops\":[{\"score\":{\"$" + "gte\":40}}]}}")
    require(found.contains("\"$id\":") && found.contains("\"active\":true")) { "findDocs did not return Kotlin document: $found" }
    println("{\"ok\":true,\"id\":\"$id\"}")
}
`
        )
        const compile = await run(['kotlinc', source, '-include-runtime', '-d', jar], {
            timeout: 120_000
        })
        expectSuccess('kotlinc interop compile', compile)

        const result = await run(['java', '-jar', jar, binaryPath, root], { timeout: 120_000 })
        expectSuccess('kotlin interop', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('Rust can drive FYLO through the machine JSON protocol', async () => {
        await requireCommand('rustc')
        const root = await tempRoot('fylo-rust-')
        const workspace = await tempWorkspace('fylo-rust-src-')
        const source = path.join(workspace, 'interop.rs')
        const executable = path.join(workspace, 'interop-rust')
        await writeFile(
            source,
            String.raw`use std::env;
use std::process::Command;

fn escape_json(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn extract_result_string(payload: &str) -> String {
    let marker = "\"result\":\"";
    let start = payload.find(marker).expect("missing result string") + marker.len();
    let tail = &payload[start..];
    let end = tail.find('"').expect("unterminated result string");
    tail[..end].to_string()
}

fn call(binary: &str, request: &str) -> String {
    let output = Command::new(binary)
        .args(["exec", "--request", request])
        .output()
        .expect("failed to run fylo binary");
    if !output.status.success() {
        panic!("{}", String::from_utf8_lossy(&output.stderr));
    }
    let stdout = String::from_utf8(output.stdout).expect("stdout is not utf8");
    if !stdout.contains("\"ok\":true") {
        panic!("{}", stdout);
    }
    stdout
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let binary = &args[1];
    let root = escape_json(&args[2]);
    let collection = "interop-rust";
    call(binary, &format!(r#"{{"op":"createCollection","root":"{}","collection":"{}"}}"#, root, collection));
    let put = call(binary, &format!(
        r#"{{"op":"putData","root":"{}","collection":"{}","data":{{"language":"rust","active":true,"score":50}}}}"#,
        root, collection
    ));
    let id = extract_result_string(&put);
    let latest = call(binary, &format!(
        r#"{{"op":"getLatest","root":"{}","collection":"{}","id":"{}"}}"#,
        root, collection, id
    ));
    if !latest.contains("\"language\":\"rust\"") {
        panic!("getLatest did not round-trip Rust document: {}", latest);
    }
    let found = call(binary, &format!(
        r#"{{"op":"findDocs","root":"{}","collection":"{}","query":{{"$ops":[{{"score":{{"$gte":40}}}}]}}}}"#,
        root, collection
    ));
    if !found.contains(&format!("\"{}\":", id)) || !found.contains("\"active\":true") {
        panic!("findDocs did not return Rust document: {}", found);
    }
    println!("{{\"ok\":true,\"id\":\"{}\"}}", id);
}
`
        )
        const compile = await run(['rustc', source, '-o', executable], { timeout: 120_000 })
        expectSuccess('rustc interop compile', compile)

        const result = await run([executable, binaryPath, root], { timeout: 120_000 })
        expectSuccess('rust interop', result)
        expect(JSON.parse(result.stdout).ok).toBe(true)
    })

    test('persistent --loop serves many requests over one warm process', async () => {
        const root = await tempRoot('fylo-loop-')
        const collection = 'interop-loop'
        // Five requests down a single process: create, put, getLatest, put, findDocs.
        const requests = [
            { op: 'createCollection', requestId: 'r1', root, collection },
            {
                op: 'putData',
                requestId: 'r2',
                root,
                collection,
                data: { language: 'loop', score: 10 }
            },
            {
                op: 'putData',
                requestId: 'r3',
                root,
                collection,
                data: { language: 'loop', score: 90 }
            },
            {
                op: 'findDocs',
                requestId: 'r4',
                root,
                collection,
                query: { $ops: [{ score: { $gte: 50 } }] }
            }
        ]
        const stdin = requests.map((r) => JSON.stringify(r)).join('\n') + '\n'
        const result = await run([binaryPath, 'exec', '--loop', '--root', root], { stdin })
        expectSuccess('loop interop', result)
        const responses = result.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        // One response per request, order and requestId preserved.
        expect(responses.map((r) => r.requestId)).toEqual(['r1', 'r2', 'r3', 'r4'])
        expect(responses.every((r) => r.ok)).toBe(true)
        // The high-score doc is found; the low-score one is filtered out.
        const found = JSON.stringify(responses[3].result)
        expect(found).toContain('"score":90')
        expect(found).not.toContain('"score":10')
    })
})

// These exercise the actual client shims in clients/<lang>/ — their named-method
// API and native (non-JSON-string) object arguments — rather than the raw
// protocol. Each copies the shim next to a small driver and runs it warm.
describe('language client shims', () => {
    /** @param {string} lang @param {string} file */
    function shimSource(lang, file) {
        return path.join(repoRoot, 'clients', lang, file)
    }

    /**
     * @param {string} label
     * @param {Awaited<ReturnType<typeof run>>} result
     */
    function expectShimOk(label, result) {
        expectSuccess(label, result)
        expect(result.stdout, `${label} stdout:\n${result.stdout}`).toContain('"ok":true')
    }

    test('Python shim drives named methods with a native dict', async () => {
        await requireCommand('python3')
        const root = await tempRoot('fylo-shim-py-')
        const ws = await tempWorkspace('fylo-shim-py-src-')
        await cp(shimSource('python', 'fylo.py'), path.join(ws, 'fylo.py'))
        await writeFile(
            path.join(ws, 'driver.py'),
            String.raw`import sys
from fylo import Fylo

binary, root = sys.argv[1], sys.argv[2]
with Fylo(root, binary=binary) as db:
    db.create_collection("users")
    doc_id = db.put_data("users", {"name": "Ada", "role": "admin", "age": 30})
    doc = db.get_latest("users", doc_id)
    found = db.find_docs("users", {"$ops": [{"age": {"$gte": 18}}]})
    assert doc[doc_id]["name"] == "Ada", doc
    assert found, "no match"
    print('{"ok":true}')
`
        )
        const result = await run(['python3', 'driver.py', binaryPath, root], { cwd: ws })
        expectShimOk('python shim', result)
        expect(existsSync(path.join(ws, '__pycache__'))).toBe(false)
    })

    test('Ruby shim drives named methods with a native Hash', async () => {
        await requireCommand('ruby')
        const root = await tempRoot('fylo-shim-rb-')
        const ws = await tempWorkspace('fylo-shim-rb-src-')
        await cp(shimSource('ruby', 'fylo.rb'), path.join(ws, 'fylo.rb'))
        await writeFile(
            path.join(ws, 'driver.rb'),
            String.raw`require_relative "fylo"

binary, root = ARGV[0], ARGV[1]
Fylo.open(root, binary: binary) do |db|
  db.create_collection("users")
  id = db.put_data("users", { "name" => "Ada", "role" => "admin", "age" => 30 })
  doc = db.get_latest("users", id)
  found = db.find_docs("users", { "$ops" => [{ "age" => { "$gte" => 18 } }] })
  raise "bad result" unless doc[id]["name"] == "Ada" && found
  puts '{"ok":true}'
end
`
        )
        const result = await run(['ruby', 'driver.rb', binaryPath, root], { cwd: ws })
        expectShimOk('ruby shim', result)
    })

    test('Node shim drives named methods with a native object', async () => {
        const root = await tempRoot('fylo-shim-node-')
        const ws = await tempWorkspace('fylo-shim-node-src-')
        await cp(shimSource('node', 'fylo.mjs'), path.join(ws, 'fylo.mjs'))
        await writeFile(
            path.join(ws, 'driver.mjs'),
            String.raw`import { Fylo } from './fylo.mjs'

const [binary, root] = [process.argv[2], process.argv[3]]
const db = new Fylo(root, { binary })
await db.createCollection('users')
const id = await db.putData('users', { name: 'Ada', role: 'admin', age: 30 })
const doc = await db.getLatest('users', id)
const found = await db.findDocs('users', { $ops: [{ age: { $gte: 18 } }] })
if (doc[id].name !== 'Ada' || !found) throw new Error('bad result')
await db.close()
console.log('{"ok":true}')
`
        )
        const result = await run(['bun', 'driver.mjs', binaryPath, root], { cwd: ws })
        expectShimOk('node shim', result)
    })

    test('PHP shim drives named methods with a native array', async () => {
        await requireCommand('php')
        const root = await tempRoot('fylo-shim-php-')
        const ws = await tempWorkspace('fylo-shim-php-src-')
        await cp(shimSource('php', 'fylo.php'), path.join(ws, 'fylo.php'))
        await writeFile(
            path.join(ws, 'driver.php'),
            String.raw`<?php
require 'fylo.php';

$binary = $argv[1];
$root = $argv[2];
$uid = (int) $argv[3];
$db = new Fylo($root, $binary);
$protected = $db->queuePublish(
    'php.protected',
    ['job' => 7],
    [
        'delayMs' => 0,
        'idempotencyKey' => 'php-protected-1',
        'op' => 'handshake',
        'topic' => 'php.overridden',
        'payload' => ['job' => 99],
        'root' => '/tmp/fylo-queue-option-injection',
    ],
);
$protectedDeliveries = $db->queueClaim(
    'php.protected',
    'php-protected-worker',
    [
        'maxMessages' => 1,
        'visibilityTimeoutMs' => 30000,
        'maxAttempts' => 1,
        'op' => 'handshake',
        'topic' => 'php.overridden',
        'group' => 'php-overridden-worker',
    ],
);
$protectedDelivery = $protectedDeliveries[0] ?? null;
if (
    ($protected['id'] ?? null) !== ($protectedDelivery['id'] ?? null) ||
    ($protectedDelivery['payload']['job'] ?? null) !== 7
) {
    throw new Exception('PHP queue options altered protected request fields');
}
$protectedNack = $db->queueNack(
    'php.protected',
    'php-protected-worker',
    $protectedDelivery['id'],
    $protectedDelivery['receipt'],
    [
        'delayMs' => 0,
        'reason' => 'expected protected-option regression',
        'op' => 'handshake',
        'topic' => 'php.overridden',
        'group' => 'php-overridden-worker',
        'id' => 'overridden-id',
        'receipt' => 'overridden-receipt',
    ],
);
if (empty($protectedNack['deadLettered'])) {
    throw new Exception('PHP queue nack options altered protected request fields');
}
$db->createCollection("users");
$id = $db->putData("users", ["name" => "Ada", "role" => "admin", "age" => 30]);
$doc = $db->getLatest("users", $id);
$found = $db->findDocs("users", ['$ops' => [['age' => ['$gte' => 18]]]]);
if ($doc[$id]["name"] !== "Ada" || empty($found)) {
    throw new Exception("bad result");
}
$sqlId = $db->sql("INSERT INTO users (name, scope) VALUES ('SQL Ada', 'private-sql')", ['uid' => $uid, 'mode' => 0600]);
$private = $db->sql("SELECT * FROM users WHERE scope = 'private-sql'", ['uid' => $uid]);
if (($private[$sqlId]['name'] ?? null) !== 'SQL Ada') {
    throw new Exception("bad protected SQL result");
}
$db->queuePublish('php.decorated', ['job' => 1]);
$worker = new class {
    public bool $handled = false;
    #[FyloQueueConsumer('php.decorated', 'php-worker')]
    public function handle(array $delivery): void
    {
        $this->handled = ($delivery['payload']['job'] ?? null) === 1;
    }
};
$outcome = $db->runQueueConsumer($worker, 'handle');
if (!$worker->handled || $outcome['acknowledged'] !== 1) {
    throw new Exception('PHP queue attribute did not acknowledge');
}
$db->close();
echo '{"ok":true}' . "\n";
`
        )
        const result = await run(
            ['php', 'driver.php', binaryPath, root, String(process.getuid())],
            {
                cwd: ws
            }
        )
        expectShimOk('php shim', result)
    })

    test('Go shim drives named methods with a native map', async () => {
        await requireCommand('go')
        const root = await tempRoot('fylo-shim-go-')
        const ws = await tempWorkspace('fylo-shim-go-src-')
        await mkdir(path.join(ws, 'fylo'), { recursive: true })
        await cp(shimSource('go', 'fylo.go'), path.join(ws, 'fylo', 'fylo.go'))
        await writeFile(path.join(ws, 'go.mod'), 'module interop\n\ngo 1.21\n')
        await writeFile(
            path.join(ws, 'main.go'),
            String.raw`package main

import (
	"fmt"
	"os"
	"strconv"

	fylo "interop/fylo"
)

func main() {
	// args: [binaryPath, root]; Open takes (root, binary).
	db, err := fylo.Open(os.Args[2], os.Args[1])
	if err != nil {
		panic(err)
	}
	defer db.Close()
	protected, err := db.QueuePublish("go.protected", map[string]any{"job": 7}, map[string]any{
		"delayMs": 0, "idempotencyKey": "go-protected-1", "op": "handshake",
		"topic": "go.overridden", "payload": map[string]any{"job": 99},
		"root": "/tmp/fylo-queue-option-injection",
	})
	if err != nil {
		panic(err)
	}
	claimed, err := db.QueueClaim("go.protected", "go-protected-worker", map[string]any{
		"maxMessages": 1, "visibilityTimeoutMs": 30000, "maxAttempts": 1,
		"op": "handshake", "topic": "go.overridden", "group": "go-overridden-worker",
	})
	if err != nil {
		panic(err)
	}
	protectedResult, ok := protected.(map[string]any)
	deliveries, deliveriesOK := claimed.([]any)
	if !ok || !deliveriesOK || len(deliveries) != 1 {
		panic("Go queue options altered protected request fields")
	}
	delivery, ok := deliveries[0].(map[string]any)
	payload, payloadOK := delivery["payload"].(map[string]any)
	if !ok || !payloadOK || delivery["id"] != protectedResult["id"] || payload["job"] != float64(7) {
		panic("Go queue options altered protected request values")
	}
	settled, err := db.QueueNack(
		"go.protected", "go-protected-worker", delivery["id"].(string), delivery["receipt"].(string),
		map[string]any{
			"delayMs": 0, "reason": "expected protected-option regression", "op": "handshake",
			"topic": "go.overridden", "group": "go-overridden-worker",
			"id": "overridden-id", "receipt": "overridden-receipt",
		},
	)
	settlement, settlementOK := settled.(map[string]any)
	if err != nil || !settlementOK || settlement["deadLettered"] != true {
		panic("Go queue nack options altered protected request fields")
	}
	db.CreateCollection("users", "document")
	id, err := db.PutData("users", map[string]any{"name": "Ada", "role": "admin", "age": 30})
	if err != nil {
		panic(err)
	}
	doc, _ := db.GetLatest("users", id.(string))
	found, _ := db.FindDocs("users", map[string]any{
		"$ops": []any{map[string]any{"age": map[string]any{"$gte": 18}}}})
	if doc == nil || found == nil {
		panic("bad result")
	}
	uid, err := strconv.Atoi(os.Args[3])
	if err != nil {
		panic(err)
	}
	sqlID, err := db.Sql("INSERT INTO users (name, scope) VALUES ('SQL Ada', 'private-sql')", map[string]any{"uid": uid, "mode": 0o600})
	if err != nil {
		panic(err)
	}
	private, err := db.Sql("SELECT * FROM users WHERE scope = 'private-sql'", map[string]any{"uid": uid})
	if err != nil || sqlID == nil || private == nil {
		panic("bad protected SQL result")
	}
	if _, err := db.QueuePublish("go.decorated", map[string]any{"job": 1}, nil); err != nil {
		panic(err)
	}
	handled := false
	consume := db.QueueConsumer("go.decorated", "go-worker", func(delivery map[string]any) error {
		payload, _ := delivery["payload"].(map[string]any)
		handled = payload["job"] == float64(1)
		return nil
	}, fylo.QueueConsumerOptions{})
	outcome, err := consume()
	if err != nil || !handled || outcome.Acknowledged != 1 {
		panic("Go queue consumer did not acknowledge")
	}
	fmt.Println(` +
                '`{"ok":true}`' +
                `)
}
`
        )
        const result = await run(['go', 'run', '.', binaryPath, root, String(process.getuid())], {
            cwd: ws,
            timeout: 120_000
        })
        expectShimOk('go shim', result)
    })

    test('Rust shim drives named methods with the Json builder', async () => {
        await requireCommand('rustc')
        const root = await tempRoot('fylo-shim-rs-')
        const ws = await tempWorkspace('fylo-shim-rs-src-')
        await cp(shimSource('rust', 'fylo.rs'), path.join(ws, 'fylo.rs'))
        await writeFile(
            path.join(ws, 'main.rs'),
            String.raw`#[path = "fylo.rs"]
mod fylo;
use fylo::{Fylo, Json, QueueConsumerOptions};

fn main() {
    let binary = std::env::args().nth(1).unwrap();
    let root = std::env::args().nth(2).unwrap();
    let uid = std::env::args().nth(3).unwrap().parse::<u32>().unwrap();
    let gid = std::env::args().nth(4).unwrap().parse::<u32>().unwrap();
    let mut db = Fylo::open(&root, &binary).unwrap();
    db.create_collection("users", "document").unwrap();
    let put = db
        .put_data(
            "users",
            Json::obj(vec![("name", "Ada".into()), ("role", "admin".into()), ("age", 30.into())]),
        )
        .unwrap();
    let marker = "\"result\":\"";
    let start = put.find(marker).expect("missing document id") + marker.len();
    let id_tail = &put[start..];
    let id = &id_tail[..id_tail.find('"').expect("unterminated document id")];
    db.set_meta(
        "users",
        id,
        Json::obj(vec![("source", "rust".into()), ("reviewed", false.into())]),
    )
    .unwrap();
    let initial_meta = db.get_meta("users", id).unwrap();
    assert!(initial_meta.contains("\"source\":\"rust\""), "{initial_meta}");
    assert!(initial_meta.contains("\"reviewed\":false"), "{initial_meta}");
    db.set_meta("users", id, Json::obj(vec![("source", Json::Null)]))
        .unwrap();
    let updated_meta = db.get_meta("users", id).unwrap();
    assert!(!updated_meta.contains("\"source\""), "{updated_meta}");
    assert!(updated_meta.contains("\"reviewed\":false"), "{updated_meta}");
    let found = db
        .find_docs(
            "users",
            Json::obj(vec![(
                "$ops",
                Json::arr(vec![Json::obj(vec![("age", Json::obj(vec![("$gte", 18.into())]))])]),
            )]),
        )
        .unwrap();
    assert!(put.contains("\"result\""));
    assert!(found.contains("\"ok\":true"));
    let sql_put = db
        .sql_as(
            "INSERT INTO users (name, scope) VALUES ('SQL Ada', 'private-sql')",
            uid,
            Some(0o600),
        )
        .unwrap();
    let private = db
        .sql_as(
            "SELECT * FROM users WHERE scope = 'private-sql'",
            uid,
            None,
        )
        .unwrap();
    assert!(sql_put.contains("\"ok\":true"), "{sql_put}");
    assert!(private.contains("SQL Ada"), "{private}");
    let group_sql_put = db
        .sql_access(
            "INSERT INTO users (name, scope) VALUES ('Group SQL Ada', 'group-sql')",
            None,
            Some(gid),
            Some(0o660),
        )
        .unwrap();
    assert!(group_sql_put.contains("\"ok\":true"), "{group_sql_put}");
    db.queue_publish(
        "rust.decorated",
        Json::obj(vec![("job", 1.into())]),
        0,
        None,
    )
    .unwrap();
    {
        let mut consume = db.queue_consumer(
            "rust.decorated",
            "rust-worker",
            QueueConsumerOptions::default(),
            |delivery| {
                assert!(delivery.contains("\"job\":1"), "{delivery}");
                Ok(())
            },
        );
        let outcome = consume().unwrap();
        assert_eq!(outcome.acknowledged, 1);
    }
    println!("{{\"ok\":true}}");
}
`
        )
        const executable = path.join(ws, 'app')
        const compile = await run(['rustc', path.join(ws, 'main.rs'), '-o', executable], {
            timeout: 120_000
        })
        expectSuccess('rustc shim compile', compile)
        const result = await run(
            [executable, binaryPath, root, String(process.getuid()), String(process.getgid())],
            {
                timeout: 120_000
            }
        )
        expectShimOk('rust shim', result)
    })

    test('Java shim drives named methods with native Maps', async () => {
        await requireCommand('javac')
        const root = await tempRoot('fylo-shim-java-')
        const ws = await tempWorkspace('fylo-shim-java-src-')
        await cp(shimSource('java', 'Fylo.java'), path.join(ws, 'Fylo.java'))
        await writeFile(
            path.join(ws, 'Interop.java'),
            String.raw`import java.util.List;
import java.util.Map;

public class Interop {
    static final class Workers {
        boolean handled;

        @Fylo.QueueConsumer(topic = "java.decorated", group = "java-worker")
        void handle(String delivery) {
            handled = delivery.contains("\"job\":1");
        }
    }

    public static void main(String[] a) throws Exception {
        try (Fylo db = new Fylo(a[1], a[0])) {
            int uid = Integer.parseInt(a[2]);
            db.createCollection("users");
            String put = db.putData("users", Map.of("name", "Ada", "role", "admin", "age", 30));
            String found = db.findDocs("users",
                Map.of("$ops", List.of(Map.of("age", Map.of("$gte", 18)))));
            if (!put.contains("\"result\"") || !found.contains("\"ok\":true")) {
                throw new Exception("bad result");
            }
            String sqlPut = db.sql(
                "INSERT INTO users (name, scope) VALUES ('SQL Ada', 'private-sql')",
                Map.of("uid", uid, "mode", 384));
            String privateRows = db.sql(
                "SELECT * FROM users WHERE scope = 'private-sql'",
                Map.of("uid", uid));
            if (!sqlPut.contains("\"result\"") || !privateRows.contains("SQL Ada")) {
                throw new Exception("bad protected SQL result");
            }
            db.queuePublish("java.decorated", Map.of("job", 1));
            Workers workers = new Workers();
            Fylo.QueueProcessResult outcome = db.runQueueConsumer(workers, "handle");
            if (!workers.handled || outcome.acknowledged != 1) {
                throw new Exception("Java queue annotation did not acknowledge");
            }
            System.out.println("{\"ok\":true}");
        }
    }
}
`
        )
        const compile = await run(['javac', 'Fylo.java', 'Interop.java'], {
            cwd: ws,
            timeout: 120_000
        })
        expectSuccess('javac shim compile', compile)
        const result = await run(
            ['java', '-cp', ws, 'Interop', binaryPath, root, String(process.getuid())],
            {
                timeout: 120_000
            }
        )
        expectShimOk('java shim', result)
    })

    test('C# shim drives named methods with a native Dictionary', async () => {
        await requireCommand('dotnet')
        const root = await tempRoot('fylo-shim-cs-')
        const ws = await tempWorkspace('fylo-shim-cs-src-')
        await cp(shimSource('csharp', 'Fylo.cs'), path.join(ws, 'Fylo.cs'))
        await writeFile(
            path.join(ws, 'Interop.csproj'),
            String.raw`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`
        )
        await writeFile(
            path.join(ws, 'Program.cs'),
            String.raw`using System.Collections.Generic;

var db = new Fylo.Fylo(args[1], args[0]);
var uid = int.Parse(args[2]);
db.CreateCollection("users");
var data = new Dictionary<string, object> { ["name"] = "Ada", ["role"] = "admin", ["age"] = 30 };
db.PutData("users", data);
var query = new Dictionary<string, object>
{
    ["$ops"] = new object[]
    {
        new Dictionary<string, object> { ["age"] = new Dictionary<string, object> { ["$gte"] = 18 } }
    }
};
db.FindDocs("users", query);
var sqlId = db.ExecuteSQL(
    "INSERT INTO users (name, scope) VALUES ('SQL Ada', 'private-sql')",
    new { uid, mode = 384 });
var privateRows = db.ExecuteSQL(
    "SELECT * FROM users WHERE scope = 'private-sql'",
    new { uid });
if (sqlId.GetString() is null || !privateRows.ToString().Contains("SQL Ada"))
    throw new System.Exception("bad protected SQL result");
db.QueuePublish("csharp.decorated", new { job = 1 });
var worker = new Worker();
var outcome = db.RunQueueConsumer(worker, nameof(Worker.Handle));
if (!worker.Handled || outcome.Acknowledged != 1)
    throw new System.Exception("C# queue attribute did not acknowledge");
System.Console.WriteLine("{\"ok\":true}");
db.Dispose();

sealed class Worker
{
    public bool Handled { get; private set; }

    [Fylo.FyloQueueConsumer("csharp.decorated", "csharp-worker")]
    public void Handle(System.Text.Json.JsonElement delivery)
    {
        Handled = delivery.GetProperty("payload").GetProperty("job").GetInt32() == 1;
    }
}
`
        )
        const result = await run(
            ['dotnet', 'run', '--project', ws, '--', binaryPath, root, String(process.getuid())],
            { timeout: 180_000 }
        )
        expectShimOk('csharp shim', result)
    })

    test('Dart shim drives named methods with a native Map', async () => {
        await requireCommand('dart')
        const root = await tempRoot('fylo-shim-dart-')
        const ws = await tempWorkspace('fylo-shim-dart-src-')
        await cp(shimSource('dart', 'fylo.dart'), path.join(ws, 'fylo.dart'))
        await writeFile(
            path.join(ws, 'driver.dart'),
            String.raw`import './fylo.dart';

class Workers {
  bool handled = false;

  @FyloQueueConsumer('dart.decorated', 'dart-worker')
  Future<void> handle(Map<String, dynamic> delivery) async {
    handled = (delivery['payload'] as Map)['job'] == 1;
  }
}

Future<void> main(List<String> args) async {
  final db = await Fylo.open(args[1], binary: args[0]);
  final protected = await db.queuePublish('dart.protected', {'job': 7}, {
    'delayMs': 0,
    'idempotencyKey': 'dart-protected-1',
    'op': 'handshake',
    'topic': 'dart.overridden',
    'payload': {'job': 99},
    'root': '/tmp/fylo-queue-option-injection',
  }) as Map;
  final protectedDeliveries = await db.queueClaim(
    'dart.protected',
    'dart-protected-worker',
    {
      'maxMessages': 1,
      'visibilityTimeoutMs': 30000,
      'maxAttempts': 1,
      'op': 'handshake',
      'topic': 'dart.overridden',
      'group': 'dart-overridden-worker',
    },
  ) as List;
  final protectedDelivery = protectedDeliveries.single as Map;
  if (protectedDelivery['id'] != protected['id'] ||
      (protectedDelivery['payload'] as Map)['job'] != 7) {
    throw StateError('Dart queue options altered protected request fields');
  }
  final protectedNack = await db.queueNack(
    'dart.protected',
    'dart-protected-worker',
    protectedDelivery['id'] as String,
    protectedDelivery['receipt'] as String,
    {
      'delayMs': 0,
      'reason': 'expected protected-option regression',
      'op': 'handshake',
      'topic': 'dart.overridden',
      'group': 'dart-overridden-worker',
      'id': 'overridden-id',
      'receipt': 'overridden-receipt',
    },
  ) as Map;
  if (protectedNack['deadLettered'] != true) {
    throw StateError('Dart queue nack options altered protected request fields');
  }
  final uid = int.parse(args[2]);
  final gid = int.parse(args[3]);
  await db.createCollection('users');
  final id = await db.putData('users', {'name': 'Ada', 'role': 'admin', 'age': 30}) as String;
  final doc = await db.getLatest('users', id) as Map;
  final found = await db.findDocs('users', {r'$ops': [{'age': {r'$gte': 18}}]}) as Map;
  if ((doc[id] as Map)['name'] != 'Ada' || found.isEmpty) throw StateError('bad result');
  final sqlId = await db.sql(
    "INSERT INTO users (name, scope) VALUES ('SQL Ada', 'private-sql')",
    uid: uid,
    mode: 384,
  ) as String;
  final privateRows = await db.sql(
    "SELECT * FROM users WHERE scope = 'private-sql'",
    uid: uid,
  ) as Map;
  if ((privateRows[sqlId] as Map)['name'] != 'SQL Ada') {
    throw StateError('bad protected SQL result');
  }
  final groupSqlId = await db.sql(
    "INSERT INTO users (name, scope) VALUES ('Group SQL Ada', 'group-sql')",
    gid: gid,
    mode: 432,
  ) as String;
  if (groupSqlId.isEmpty) throw StateError('bad group SQL result');
  await db.queuePublish('dart.decorated', {'job': 1});
  final worker = Workers();
  final consume = db.queueConsumer(
    const FyloQueueConsumer('dart.decorated', 'dart-worker'),
    worker.handle,
  );
  final outcome = await consume();
  if (!worker.handled || outcome.acknowledged != 1) {
    throw StateError('Dart queue annotation adapter did not acknowledge');
  }
  await db.close();
  print('{"ok":true}');
}
`
        )
        const result = await run(
            [
                'dart',
                'driver.dart',
                binaryPath,
                root,
                String(process.getuid()),
                String(process.getgid())
            ],
            {
                cwd: ws,
                timeout: 120_000
            }
        )
        expectShimOk('dart shim', result)
    })
})
