import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Fylo as MachineFylo } from '../clients/node/fylo.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = await mkdtemp(join(tmpdir(), 'fylo-rust-clients-'))
const collection = 'users'

const rustBinary = process.env.FYLO_RUST_BINARY
    ? resolve(process.env.FYLO_RUST_BINARY)
    : join(repo, 'target', 'debug', platform() === 'win32' ? 'fylo-rust.exe' : 'fylo-rust')

try {
    if (process.env.FYLO_SKIP_RUST_BUILD !== '1') {
        await command([
            process.execPath,
            './scripts/run-rust.mjs',
            'cargo',
            'build',
            '--locked',
            '-p',
            'fylo-cli',
            '--bin',
            'fylo-rust'
        ])
    }

    const clients = await clientProbes(workspace)
    const required = new Set(
        (process.env.FYLO_REQUIRED_LANGUAGE_CLIENTS ?? 'node,python,ruby,php,go,java,rust')
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
    )
    const available = []
    for (const client of clients) {
        if (!(await commandExists(client.command))) {
            if (required.has(client.name)) {
                throw new Error(`required language client tool is unavailable: ${client.command}`)
            }
            console.log(`Skipping ${client.name}: ${client.command} is unavailable`)
            continue
        }
        available.push(client)
    }
    for (const requiredName of required) {
        if (!available.some((client) => client.name === requiredName)) {
            throw new Error(`required language client probe is unavailable: ${requiredName}`)
        }
    }

    for (const client of available) {
        const root = join(workspace, `${client.name}-rust`)
        const identifier = await seed(root, rustBinary)
        const reviewer = `${client.name}-rust`
        await client.run(rustBinary, root, reviewer, identifier)
        await verify(root, rustBinary, reviewer, identifier)
    }
    console.log(`Verified ${available.length} published language clients against the Rust engine`)
} finally {
    await rm(workspace, { recursive: true, force: true })
}

async function seed(root, binary) {
    await mkdir(root, { recursive: true })
    const db = new MachineFylo(root, { binary, exclusiveRoot: true })
    try {
        await db.ready
        const create = await db.request({
            op: 'createCollection',
            collection,
            kind: 'document'
        })
        if (!create.ok) {
            throw new Error(
                `createCollection seed failed (${create.error?.code}): ${create.error?.message}`
            )
        }
        const put = await db.request({
            op: 'putData',
            collection,
            data: { name: 'Ada', role: 'admin' }
        })
        if (!put.ok) {
            throw new Error(`putData seed failed (${put.error?.code}): ${put.error?.message}`)
        }
        return put.result
    } finally {
        await db.close()
    }
}

async function verify(root, binary, reviewer, identifier) {
    const db = new MachineFylo(root, { binary, exclusiveRoot: true })
    await db.ready
    const metadata = await db.getMeta(collection, identifier)
    if (metadata.reviewer !== reviewer || metadata.id !== identifier) {
        throw new Error(`client metadata did not round-trip: ${reviewer}`)
    }
    await db.close()
}

async function clientProbes(root) {
    const probes = []
    probes.push(await nodeProbe(root))
    probes.push(await pythonProbe(root))
    probes.push(await rubyProbe(root))
    probes.push(await phpProbe(root))
    probes.push(await goProbe(root))
    probes.push(await javaProbe(root))
    probes.push(await rustProbe(root))
    probes.push(await csharpProbe(root))
    probes.push(await dartProbe(root))
    return probes
}

async function nodeProbe(root) {
    const source = join(root, 'node-probe.mjs')
    await writeFile(
        source,
        `import { Fylo } from ${JSON.stringify(resolve('clients/node/fylo.mjs'))}
const [binary, root, reviewer, id] = process.argv.slice(2)
const db = new Fylo(root, { binary })
try {
  const get = await db.request({ op: 'getLatest', collection: 'users', id })
  const find = await db.request({ op: 'findDocs', collection: 'users', query: { $ops: [{ role: { $eq: 'admin' } }] } })
  const meta = await db.request({ op: 'setMeta', collection: 'users', id, meta: { reviewer } })
  if (get.result[id].name !== 'Ada' || Object.keys(find.result).length !== 1 || meta.result.reviewer !== reviewer) throw new Error('node client corpus mismatch: ' + JSON.stringify({ get, find, meta }))
} finally { await db.close() }
`
    )
    return probe('node', 'node', (binary, database, reviewer, identifier) =>
        command(['node', source, binary, database, reviewer, identifier])
    )
}

async function pythonProbe(root) {
    const source = join(root, 'python_probe.py')
    await writeFile(
        source,
        `import sys
sys.path.insert(0, ${JSON.stringify(resolve('clients/python'))})
from fylo import Fylo
binary, root, reviewer, identifier = sys.argv[1:]
with Fylo(root, binary=binary) as db:
    get = db.request({'op':'getLatest','collection':'users','id':identifier})
    find = db.request({'op':'findDocs','collection':'users','query':{'$ops':[{'role':{'$eq':'admin'}}]}})
    meta = db.request({'op':'setMeta','collection':'users','id':identifier,'meta':{'reviewer':reviewer}})
    assert get['result'][identifier]['name'] == 'Ada'
    assert len(find['result']) == 1
    assert meta['result']['reviewer'] == reviewer
`
    )
    return probe('python', 'python3', (binary, database, reviewer, identifier) =>
        command(['python3', source, binary, database, reviewer, identifier])
    )
}

async function rubyProbe(root) {
    const source = join(root, 'ruby_probe.rb')
    await writeFile(
        source,
        `require ${JSON.stringify(resolve('clients/ruby/fylo.rb'))}
binary, root, reviewer, identifier = ARGV
Fylo.open(root, binary: binary) do |db|
  get = db.request({'op'=>'getLatest','collection'=>'users','id'=>identifier})
  find = db.request({'op'=>'findDocs','collection'=>'users','query'=>{'$ops'=>[{'role'=>{'$eq'=>'admin'}}]}})
  meta = db.request({'op'=>'setMeta','collection'=>'users','id'=>identifier,'meta'=>{'reviewer'=>reviewer}})
  raise 'ruby get mismatch' unless get['result'][identifier]['name'] == 'Ada'
  raise 'ruby find mismatch' unless find['result'].length == 1
  raise 'ruby metadata mismatch' unless meta['result']['reviewer'] == reviewer
end
`
    )
    return probe('ruby', 'ruby', (binary, database, reviewer, identifier) =>
        command(['ruby', source, binary, database, reviewer, identifier])
    )
}

async function phpProbe(root) {
    const source = join(root, 'php_probe.php')
    await writeFile(
        source,
        `<?php
require ${JSON.stringify(resolve('clients/php/fylo.php'))};
[$script, $binary, $root, $reviewer, $identifier] = $argv;
$db = new Fylo($root, $binary);
try {
  $get = $db->request(['op'=>'getLatest','collection'=>'users','id'=>$identifier]);
  $find = $db->request(['op'=>'findDocs','collection'=>'users','query'=>['$ops'=>[['role'=>['$eq'=>'admin']]]]]);
  $meta = $db->request(['op'=>'setMeta','collection'=>'users','id'=>$identifier,'meta'=>['reviewer'=>$reviewer]]);
  if ($get['result'][$identifier]['name'] !== 'Ada' || count($find['result']) !== 1 || $meta['result']['reviewer'] !== $reviewer) throw new Exception('php client corpus mismatch');
} finally { $db->close(); }
`
    )
    return probe('php', 'php', (binary, database, reviewer, identifier) =>
        command(['php', source, binary, database, reviewer, identifier])
    )
}

async function goProbe(root) {
    const directory = join(root, 'go')
    await mkdir(join(directory, 'fylo'), { recursive: true })
    await copyFile(resolve('clients/go/fylo.go'), join(directory, 'fylo', 'fylo.go'))
    await writeFile(join(directory, 'go.mod'), 'module fylo-probe\n\ngo 1.24\n')
    await writeFile(
        join(directory, 'main.go'),
        `package main
import ("fmt"; "os"; fylo "fylo-probe/fylo")
func main() {
  db, err := fylo.Open(os.Args[2], os.Args[1]); if err != nil { panic(err) }; defer db.Close()
  get, err := db.Request(map[string]any{"op":"getLatest","collection":"users","id":os.Args[4]}); if err != nil { panic(err) }
  find, err := db.Request(map[string]any{"op":"findDocs","collection":"users","query":map[string]any{"$ops":[]any{map[string]any{"role":map[string]any{"$eq":"admin"}}}}}); if err != nil { panic(err) }
  meta, err := db.Request(map[string]any{"op":"setMeta","collection":"users","id":os.Args[4],"meta":map[string]any{"reviewer":os.Args[3]}}); if err != nil { panic(err) }
  doc := get["result"].(map[string]any)[os.Args[4]].(map[string]any)
  if doc["name"] != "Ada" || len(find["result"].(map[string]any)) != 1 || meta["result"].(map[string]any)["reviewer"] != os.Args[3] { panic("go client corpus mismatch") }
  fmt.Print("ok")
}
`
    )
    return probe('go', 'go', (binary, database, reviewer, identifier) =>
        command(['go', 'run', '.', binary, database, reviewer, identifier], { cwd: directory })
    )
}

async function javaProbe(root) {
    const directory = join(root, 'java')
    await mkdir(directory, { recursive: true })
    await copyFile(resolve('clients/java/Fylo.java'), join(directory, 'Fylo.java'))
    await writeFile(
        join(directory, 'Probe.java'),
        `public final class Probe {
  public static void main(String[] args) throws Exception {
    try (Fylo db = new Fylo(args[1], args[0])) {
      String get = db.request("{\\"op\\":\\"getLatest\\",\\"collection\\":\\"users\\",\\"id\\":\\"" + args[3] + "\\"}");
      String find = db.request("{\\"op\\":\\"findDocs\\",\\"collection\\":\\"users\\",\\"query\\":{\\"$ops\\":[{\\"role\\":{\\"$eq\\":\\"admin\\"}}]}}");
      String meta = db.request("{\\"op\\":\\"setMeta\\",\\"collection\\":\\"users\\",\\"id\\":\\"" + args[3] + "\\",\\"meta\\":{\\"reviewer\\":\\"" + args[2] + "\\"}}");
      if (!get.contains("\\"name\\":\\"Ada\\"") || !find.contains(args[3]) || !meta.contains("\\"reviewer\\":\\"" + args[2] + "\\"")) throw new IllegalStateException("java client corpus mismatch");
    }
  }
}
`
    )
    await command(['javac', 'Fylo.java', 'Probe.java'], { cwd: directory })
    return probe('java', 'java', (binary, database, reviewer, identifier) =>
        command(['java', '-cp', directory, 'Probe', binary, database, reviewer, identifier])
    )
}

async function rustProbe(root) {
    const directory = join(root, 'rust')
    await mkdir(directory, { recursive: true })
    await copyFile(resolve('clients/rust/fylo.rs'), join(directory, 'fylo.rs'))
    await writeFile(
        join(directory, 'probe.rs'),
        `mod fylo;
use fylo::Fylo;
fn main() {
  let args: Vec<String> = std::env::args().collect();
  let mut db = Fylo::open(&args[2], &args[1]).unwrap();
  let get = db.request(&format!(r#"{{"op":"getLatest","collection":"users","id":"{}"}}"#, args[4])).unwrap();
  let find = db.request(r#"{"op":"findDocs","collection":"users","query":{"$ops":[{"role":{"$eq":"admin"}}]}}"#).unwrap();
  let meta = db.request(&format!(r#"{{"op":"setMeta","collection":"users","id":"{}","meta":{{"reviewer":"{}"}}}}"#, args[4], args[3])).unwrap();
  assert!(get.contains(r#""name":"Ada""#) && find.contains(&args[4]) && meta.contains(&format!(r#""reviewer":"{}""#, args[3])));
}
`
    )
    const executable = join(directory, platform() === 'win32' ? 'probe.exe' : 'probe')
    await command(['rustc', 'probe.rs', '-o', executable], { cwd: directory })
    return probe('rust', 'rustc', (binary, database, reviewer, identifier) =>
        command([executable, binary, database, reviewer, identifier])
    )
}

async function csharpProbe(root) {
    const directory = join(root, 'csharp')
    await mkdir(directory, { recursive: true })
    await copyFile(resolve('clients/csharp/Fylo.cs'), join(directory, 'Fylo.cs'))
    await writeFile(
        join(directory, 'Probe.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>'
    )
    await writeFile(
        join(directory, 'Program.cs'),
        `using Fylo;
using var db = new Fylo.Fylo(args[1], args[0]);
using var get = db.Request($"{{\\"op\\":\\"getLatest\\",\\"collection\\":\\"users\\",\\"id\\":\\"{args[3]}\\"}}");
using var find = db.Request("{\\"op\\":\\"findDocs\\",\\"collection\\":\\"users\\",\\"query\\":{\\"$ops\\":[{\\"role\\":{\\"$eq\\":\\"admin\\"}}]}}");
using var meta = db.Request($"{{\\"op\\":\\"setMeta\\",\\"collection\\":\\"users\\",\\"id\\":\\"{args[3]}\\",\\"meta\\":{{\\"reviewer\\":\\"{args[2]}\\"}}}}");
if (get.RootElement.GetProperty("result").GetProperty(args[3]).GetProperty("name").GetString() != "Ada" || !find.RootElement.GetProperty("result").TryGetProperty(args[3], out _) || meta.RootElement.GetProperty("result").GetProperty("reviewer").GetString() != args[2]) throw new Exception("csharp client corpus mismatch");
`
    )
    return probe('csharp', 'dotnet', (binary, database, reviewer, identifier) =>
        command([
            'dotnet',
            'run',
            '--project',
            directory,
            '--',
            binary,
            database,
            reviewer,
            identifier
        ])
    )
}

async function dartProbe(root) {
    const directory = join(root, 'dart')
    await mkdir(directory, { recursive: true })
    await copyFile(resolve('clients/dart/fylo.dart'), join(directory, 'fylo.dart'))
    await writeFile(
        join(directory, 'probe.dart'),
        `import 'dart:io';
import 'fylo.dart';
Future<void> main(List<String> args) async {
  final db = await Fylo.open(args[1], binary: args[0]);
  try {
    final get = await db.request({'op':'getLatest','collection':'users','id':args[3]});
    final find = await db.request({'op':'findDocs','collection':'users','query':{r'$ops':[{'role':{r'$eq':'admin'}}]}});
    final meta = await db.request({'op':'setMeta','collection':'users','id':args[3],'meta':{'reviewer':args[2]}});
    if (get['result'][args[3]]['name'] != 'Ada' || find['result'].length != 1 || meta['result']['reviewer'] != args[2]) throw StateError('dart client corpus mismatch');
  } finally { await db.close(); }
}
`
    )
    return probe('dart', 'dart', (binary, database, reviewer, identifier) =>
        command([
            'dart',
            'run',
            sourcePath(directory, 'probe.dart'),
            binary,
            database,
            reviewer,
            identifier
        ])
    )
}

function sourcePath(directory, name) {
    return join(directory, name)
}

function probe(name, commandName, run) {
    return { name, command: commandName, run }
}

async function commandExists(name) {
    return Boolean(Bun.which(name))
}

async function command(arguments_, options = {}) {
    const process = Bun.spawn(arguments_, {
        cwd: options.cwd ?? repo,
        env: {
            ...globalThis.process.env,
            DOTNET_CLI_TELEMETRY_OPTOUT: '1',
            PYTHONDONTWRITEBYTECODE: '1'
        },
        stdout: 'pipe',
        stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited
    ])
    if (exitCode !== 0) {
        throw new Error(
            `${arguments_.join(' ')} failed (${exitCode})\n${stderr.trim()}\n${stdout.trim()}`
        )
    }
    return stdout
}
