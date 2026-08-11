import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Fylo as MachineFylo } from '../clients/node/fylo.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = await mkdtemp(join(tmpdir(), 'fylo-rust-clients-'))
const collection = 'users'
const unsetEnvironment = '__FYLO_TEST_UNSET_ENVIRONMENT__'
const secretSentinel = 'FYLO_SECRET_SENTINEL_MUST_NOT_LEAK'

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
        const unsetRoot = join(workspace, `${client.name}-unset-rust`)
        const environmentFile = join(root, 'fylo.env')
        await mkdir(root, { recursive: true })
        await mkdir(unsetRoot, { recursive: true })
        await writeFile(
            environmentFile,
            '# This configuration belongs only to the spawned FYLO process.\nexport FYLO_SHARD_WIDTH = "2" # inline comment\n'
        )
        const identifier = await seed(root, rustBinary, environmentFile)
        const reviewer = `${client.name}-rust`
        const inheritedEnvironment = {
            [platform() === 'win32' ? 'fylo_shard_width' : 'FYLO_SHARD_WIDTH']: '4'
        }
        const output = (
            await client.run(
                rustBinary,
                root,
                reviewer,
                identifier,
                environmentFile,
                inheritedEnvironment
            )
        ).trim()
        const created = output.startsWith('{') ? JSON.parse(output).result : output
        if (!created)
            throw new Error(`${client.name} did not return its environment-scoped document`)
        await access(
            join(root, '.collections', collection, 'docs', created.slice(-2), `${created}.json`)
        )
        await verify(root, rustBinary, reviewer, identifier, environmentFile)
        const unsetOutput = (
            await client.run(
                rustBinary,
                unsetRoot,
                reviewer,
                '',
                unsetEnvironment,
                inheritedEnvironment
            )
        ).trim()
        const unsetIdentifier = unsetOutput.startsWith('{')
            ? JSON.parse(unsetOutput).result
            : unsetOutput
        if (!unsetIdentifier) {
            throw new Error(`${client.name} did not return its environment-unset document`)
        }
        await access(
            join(
                unsetRoot,
                '.collections',
                collection,
                'docs',
                unsetIdentifier.slice(-1),
                `${unsetIdentifier}.json`
            )
        )
    }
    console.log(`Verified ${available.length} published language clients against the Rust engine`)
} finally {
    await rm(workspace, { recursive: true, force: true })
}

async function seed(root, binary, env) {
    await mkdir(root, { recursive: true })
    const db = new MachineFylo(root, { binary, env, exclusiveRoot: true })
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

async function verify(root, binary, reviewer, identifier, env) {
    const db = new MachineFylo(root, { binary, env, exclusiveRoot: true })
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
const [binary, root, reviewer, id, env] = process.argv.slice(2)
let nulRejected = false
try {
  new Fylo(root, { binary, env: { FYLO_ENCRYPTION_KEY: ${JSON.stringify(secretSentinel)} + String.fromCharCode(0) + 'tail' } })
} catch (error) {
  nulRejected = error.message.includes('FYLO_ENCRYPTION_KEY') && !error.message.includes(${JSON.stringify(secretSentinel)})
}
if (!nulRejected) throw new Error('node NUL environment value was accepted or leaked')
const configuredEnv = env === ${JSON.stringify(unsetEnvironment)} ? { FYLO_SHARD_WIDTH: null } : env
const db = new Fylo(root, { binary, env: configuredEnv })
try {
  if (env === ${JSON.stringify(unsetEnvironment)}) {
    await db.createCollection('users')
    console.log(await db.putData('users', { environment: 'node-unset' }))
    process.exitCode = 0
  } else {
  const get = await db.request({ op: 'getLatest', collection: 'users', id })
  const find = await db.request({ op: 'findDocs', collection: 'users', query: { $ops: [{ role: { $eq: 'admin' } }] } })
  const meta = await db.request({ op: 'setMeta', collection: 'users', id, meta: { reviewer } })
  if (get.result[id].name !== 'Ada' || Object.keys(find.result).length !== 1 || meta.result.reviewer !== reviewer) throw new Error('node client corpus mismatch: ' + JSON.stringify({ get, find, meta }))
  console.log(await db.putData('users', { environment: 'node' }))
  }
} finally { await db.close() }
`
    )
    return probe('node', 'node', (binary, database, reviewer, identifier, env, environment) =>
        command(['node', source, binary, database, reviewer, identifier, env], { env: environment })
    )
}

async function pythonProbe(root) {
    const source = join(root, 'python_probe.py')
    await writeFile(
        source,
        `import sys
sys.path.insert(0, ${JSON.stringify(resolve('clients/python'))})
from fylo import Fylo
binary, root, reviewer, identifier, env = sys.argv[1:]
nul_rejected = False
try:
    Fylo(root, binary=binary, env={'FYLO_ENCRYPTION_KEY': ${JSON.stringify(secretSentinel)} + chr(0) + 'tail'})
except (TypeError, ValueError) as error:
    message = str(error)
    nul_rejected = 'FYLO_ENCRYPTION_KEY' in message and ${JSON.stringify(secretSentinel)} not in message
if not nul_rejected:
    raise AssertionError('python NUL environment value was accepted or leaked')
configured_env = {'FYLO_SHARD_WIDTH': None} if env == ${JSON.stringify(unsetEnvironment)} else env
with Fylo(root, binary=binary, env=configured_env) as db:
    if env == ${JSON.stringify(unsetEnvironment)}:
        db.create_collection('users')
        print(db.put_data('users', {'environment': 'python-unset'}))
        sys.exit(0)
    get = db.request({'op':'getLatest','collection':'users','id':identifier})
    find = db.request({'op':'findDocs','collection':'users','query':{'$ops':[{'role':{'$eq':'admin'}}]}})
    meta = db.request({'op':'setMeta','collection':'users','id':identifier,'meta':{'reviewer':reviewer}})
    assert get['result'][identifier]['name'] == 'Ada'
    assert len(find['result']) == 1
    assert meta['result']['reviewer'] == reviewer
    print(db.put_data('users', {'environment': 'python'}))
`
    )
    return probe('python', 'python3', (binary, database, reviewer, identifier, env, environment) =>
        command(['python3', source, binary, database, reviewer, identifier, env], {
            env: environment
        })
    )
}

async function rubyProbe(root) {
    const source = join(root, 'ruby_probe.rb')
    await writeFile(
        source,
        `require ${JSON.stringify(resolve('clients/ruby/fylo.rb'))}
binary, root, reviewer, identifier, env = ARGV
nul_rejected = false
begin
  Fylo.new(root, binary: binary, env: { 'FYLO_ENCRYPTION_KEY' => ${JSON.stringify(secretSentinel)} + [0].pack('C') + 'tail' })
rescue ArgumentError => error
  nul_rejected = error.message.include?('FYLO_ENCRYPTION_KEY') && !error.message.include?(${JSON.stringify(secretSentinel)})
end
raise 'ruby NUL environment value was accepted or leaked' unless nul_rejected
configured_env = env == ${JSON.stringify(unsetEnvironment)} ? { 'FYLO_SHARD_WIDTH' => nil } : env
Fylo.open(root, binary: binary, env: configured_env) do |db|
  if env == ${JSON.stringify(unsetEnvironment)}
    db.create_collection('users')
    puts db.put_data('users', { 'environment' => 'ruby-unset' })
    next
  end
  get = db.request({'op'=>'getLatest','collection'=>'users','id'=>identifier})
  find = db.request({'op'=>'findDocs','collection'=>'users','query'=>{'$ops'=>[{'role'=>{'$eq'=>'admin'}}]}})
  meta = db.request({'op'=>'setMeta','collection'=>'users','id'=>identifier,'meta'=>{'reviewer'=>reviewer}})
  raise 'ruby get mismatch' unless get['result'][identifier]['name'] == 'Ada'
  raise 'ruby find mismatch' unless find['result'].length == 1
  raise 'ruby metadata mismatch' unless meta['result']['reviewer'] == reviewer
  puts db.put_data('users', { 'environment' => 'ruby' })
end
`
    )
    return probe('ruby', 'ruby', (binary, database, reviewer, identifier, env, environment) =>
        command(['ruby', source, binary, database, reviewer, identifier, env], { env: environment })
    )
}

async function phpProbe(root) {
    const source = join(root, 'php_probe.php')
    await writeFile(
        source,
        `<?php
require ${JSON.stringify(resolve('clients/php/fylo.php'))};
[$script, $binary, $root, $reviewer, $identifier, $env] = $argv;
$nulRejected = false;
try {
  new Fylo($root, $binary, ['FYLO_ENCRYPTION_KEY' => ${JSON.stringify(secretSentinel)} . chr(0) . 'tail']);
} catch (InvalidArgumentException $error) {
  $nulRejected = str_contains($error->getMessage(), 'FYLO_ENCRYPTION_KEY') && !str_contains($error->getMessage(), ${JSON.stringify(secretSentinel)});
}
if (!$nulRejected) throw new Exception('php NUL environment value was accepted or leaked');
$configuredEnv = $env === ${JSON.stringify(unsetEnvironment)} ? ['FYLO_SHARD_WIDTH' => null] : $env;
$db = new Fylo($root, $binary, $configuredEnv);
try {
  if ($env === ${JSON.stringify(unsetEnvironment)}) {
    $db->createCollection('users');
    echo $db->putData('users', ['environment'=>'php-unset']);
    exit(0);
  }
  $get = $db->request(['op'=>'getLatest','collection'=>'users','id'=>$identifier]);
  $find = $db->request(['op'=>'findDocs','collection'=>'users','query'=>['$ops'=>[['role'=>['$eq'=>'admin']]]]]);
  $meta = $db->request(['op'=>'setMeta','collection'=>'users','id'=>$identifier,'meta'=>['reviewer'=>$reviewer]]);
  if ($get['result'][$identifier]['name'] !== 'Ada' || count($find['result']) !== 1 || $meta['result']['reviewer'] !== $reviewer) throw new Exception('php client corpus mismatch');
  echo $db->putData('users', ['environment'=>'php']);
} finally { $db->close(); }
`
    )
    return probe('php', 'php', (binary, database, reviewer, identifier, env, environment) =>
        command(['php', source, binary, database, reviewer, identifier, env], { env: environment })
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
import ("fmt"; "os"; "strings"; fylo "fylo-probe/fylo")
func main() {
  secret := ${JSON.stringify(secretSentinel)} + string(rune(0)) + "tail"
  _, nulErr := fylo.OpenWithOptions(os.Args[2], fylo.Options{Binary: os.Args[1], Env: &fylo.Environment{Values: map[string]*string{"FYLO_ENCRYPTION_KEY": &secret}}})
  if nulErr == nil || !strings.Contains(nulErr.Error(), "FYLO_ENCRYPTION_KEY") || strings.Contains(nulErr.Error(), ${JSON.stringify(secretSentinel)}) { panic("go NUL environment value was accepted or leaked") }
  environment := &fylo.Environment{File: os.Args[5]}
  if os.Args[5] == ${JSON.stringify(unsetEnvironment)} { environment = &fylo.Environment{Values: map[string]*string{"FYLO_SHARD_WIDTH": nil}} }
  db, err := fylo.OpenWithOptions(os.Args[2], fylo.Options{Binary: os.Args[1], Env: environment}); if err != nil { panic(err) }; defer db.Close()
  if os.Args[5] == ${JSON.stringify(unsetEnvironment)} {
    if _, err := db.CreateCollection("users", "document"); err != nil { panic(err) }
    created, err := db.PutData("users", map[string]any{"environment":"go-unset"}); if err != nil { panic(err) }
    fmt.Print(created.(string)); return
  }
  get, err := db.Request(map[string]any{"op":"getLatest","collection":"users","id":os.Args[4]}); if err != nil { panic(err) }
  find, err := db.Request(map[string]any{"op":"findDocs","collection":"users","query":map[string]any{"$ops":[]any{map[string]any{"role":map[string]any{"$eq":"admin"}}}}}); if err != nil { panic(err) }
  meta, err := db.Request(map[string]any{"op":"setMeta","collection":"users","id":os.Args[4],"meta":map[string]any{"reviewer":os.Args[3]}}); if err != nil { panic(err) }
  doc := get["result"].(map[string]any)[os.Args[4]].(map[string]any)
  if doc["name"] != "Ada" || len(find["result"].(map[string]any)) != 1 || meta["result"].(map[string]any)["reviewer"] != os.Args[3] { panic("go client corpus mismatch") }
  created, err := db.PutData("users", map[string]any{"environment":"go"}); if err != nil { panic(err) }
  fmt.Print(created.(string))
}
`
    )
    return probe('go', 'go', (binary, database, reviewer, identifier, env, environment) =>
        command(['go', 'run', '.', binary, database, reviewer, identifier, env], {
            cwd: directory,
            env: environment
        })
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
    Fylo.Options options = new Fylo.Options();
    options.binary = args[0];
    java.util.Map<String, Object> invalidEnvironment = new java.util.HashMap<>();
    invalidEnvironment.put("FYLO_ENCRYPTION_KEY", ${JSON.stringify(secretSentinel)} + String.valueOf((char) 0) + "tail");
    Fylo.Options invalidOptions = new Fylo.Options();
    invalidOptions.binary = args[0];
    invalidOptions.env = invalidEnvironment;
    boolean nulRejected = false;
    try {
      new Fylo(args[1], invalidOptions);
    } catch (IllegalArgumentException error) {
      nulRejected = error.getMessage().contains("FYLO_ENCRYPTION_KEY") && !error.getMessage().contains(${JSON.stringify(secretSentinel)});
    }
    if (!nulRejected) throw new IllegalStateException("java NUL environment value was accepted or leaked");
    if (args[4].equals(${JSON.stringify(unsetEnvironment)})) {
      java.util.Map<String, Object> environment = new java.util.HashMap<>();
      environment.put("FYLO_SHARD_WIDTH", null);
      options.env = environment;
    } else {
      options.env = args[4];
    }
    try (Fylo db = new Fylo(args[1], options)) {
      if (args[4].equals(${JSON.stringify(unsetEnvironment)})) {
        db.createCollection("users");
        System.out.print(db.putData("users", java.util.Map.of("environment", "java-unset")));
        return;
      }
      String get = db.request("{\\"op\\":\\"getLatest\\",\\"collection\\":\\"users\\",\\"id\\":\\"" + args[3] + "\\"}");
      String find = db.request("{\\"op\\":\\"findDocs\\",\\"collection\\":\\"users\\",\\"query\\":{\\"$ops\\":[{\\"role\\":{\\"$eq\\":\\"admin\\"}}]}}");
      String meta = db.request("{\\"op\\":\\"setMeta\\",\\"collection\\":\\"users\\",\\"id\\":\\"" + args[3] + "\\",\\"meta\\":{\\"reviewer\\":\\"" + args[2] + "\\"}}");
      if (!get.contains("\\"name\\":\\"Ada\\"") || !find.contains(args[3]) || !meta.contains("\\"reviewer\\":\\"" + args[2] + "\\"")) throw new IllegalStateException("java client corpus mismatch");
      System.out.print(db.putData("users", java.util.Map.of("environment", "java")));
    }
  }
}
`
    )
    await command(['javac', 'Fylo.java', 'Probe.java'], { cwd: directory })
    return probe('java', 'java', (binary, database, reviewer, identifier, env, environment) =>
        command(['java', '-cp', directory, 'Probe', binary, database, reviewer, identifier, env], {
            env: environment
        })
    )
}

async function rustProbe(root) {
    const directory = join(root, 'rust')
    await mkdir(directory, { recursive: true })
    await copyFile(resolve('clients/rust/fylo.rs'), join(directory, 'fylo.rs'))
    await writeFile(
        join(directory, 'probe.rs'),
        `mod fylo;
use std::collections::BTreeMap;
use fylo::{Fylo, FyloOptions, Json, ProcessEnvironment};
fn main() {
  let args: Vec<String> = std::env::args().collect();
  let mut invalid_values = BTreeMap::new();
  invalid_values.insert("FYLO_ENCRYPTION_KEY".to_string(), Some(format!("{}{}tail", ${JSON.stringify(secretSentinel)}, char::from(0))));
  let invalid_message = match Fylo::open_with_options(&args[2], FyloOptions { binary: args[1].clone(), env: Some(ProcessEnvironment::Values(invalid_values)) }) {
    Ok(_) => panic!("rust NUL environment value was accepted"),
    Err(error) => error.to_string(),
  };
  assert!(invalid_message.contains("FYLO_ENCRYPTION_KEY") && !invalid_message.contains(${JSON.stringify(secretSentinel)}), "rust NUL environment value was accepted or leaked");
  let environment = if args[5] == ${JSON.stringify(unsetEnvironment)} {
    let mut values = BTreeMap::new(); values.insert("FYLO_SHARD_WIDTH".to_string(), None); ProcessEnvironment::Values(values)
  } else { ProcessEnvironment::File(args[5].clone().into()) };
  let mut db = Fylo::open_with_options(&args[2], FyloOptions { binary: args[1].clone(), env: Some(environment) }).unwrap();
  if args[5] == ${JSON.stringify(unsetEnvironment)} {
    db.create_collection("users", "document").unwrap();
    print!("{}", db.put_data("users", Json::obj(vec![("environment", "rust-unset".into())])).unwrap());
    return;
  }
  let get = db.request(&format!(r#"{{"op":"getLatest","collection":"users","id":"{}"}}"#, args[4])).unwrap();
  let find = db.request(r#"{"op":"findDocs","collection":"users","query":{"$ops":[{"role":{"$eq":"admin"}}]}}"#).unwrap();
  let meta = db.request(&format!(r#"{{"op":"setMeta","collection":"users","id":"{}","meta":{{"reviewer":"{}"}}}}"#, args[4], args[3])).unwrap();
  assert!(get.contains(r#""name":"Ada""#) && find.contains(&args[4]) && meta.contains(&format!(r#""reviewer":"{}""#, args[3])));
  print!("{}", db.put_data("users", Json::obj(vec![("environment", "rust".into())])).unwrap());
}
`
    )
    const executable = join(directory, platform() === 'win32' ? 'probe.exe' : 'probe')
    await command(['rustc', 'probe.rs', '-o', executable], { cwd: directory })
    return probe('rust', 'rustc', (binary, database, reviewer, identifier, env, environment) =>
        command([executable, binary, database, reviewer, identifier, env], { env: environment })
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
bool nulRejected = false;
try {
    _ = new Fylo.Fylo(args[1], new Fylo.Fylo.Options {
        Binary = args[0],
        Env = new Dictionary<string, string> { ["FYLO_ENCRYPTION_KEY"] = ${JSON.stringify(secretSentinel)} + char.MinValue + "tail" }
    });
} catch (ArgumentException error) {
    nulRejected = error.Message.Contains("FYLO_ENCRYPTION_KEY") && !error.Message.Contains(${JSON.stringify(secretSentinel)});
}
if (!nulRejected) throw new Exception("csharp NUL environment value was accepted or leaked");
object environment = args[4] == ${JSON.stringify(unsetEnvironment)}
    ? new Dictionary<string, string> { ["FYLO_SHARD_WIDTH"] = null }
    : args[4];
using var db = new Fylo.Fylo(args[1], new Fylo.Fylo.Options { Binary = args[0], Env = environment });
if (args[4] == ${JSON.stringify(unsetEnvironment)}) {
    db.CreateCollection("users");
    Console.Write(db.PutData("users", new Dictionary<string, object> { ["environment"] = "csharp-unset" }).GetString());
    return;
}
using var get = db.Request($"{{\\"op\\":\\"getLatest\\",\\"collection\\":\\"users\\",\\"id\\":\\"{args[3]}\\"}}");
using var find = db.Request("{\\"op\\":\\"findDocs\\",\\"collection\\":\\"users\\",\\"query\\":{\\"$ops\\":[{\\"role\\":{\\"$eq\\":\\"admin\\"}}]}}");
using var meta = db.Request($"{{\\"op\\":\\"setMeta\\",\\"collection\\":\\"users\\",\\"id\\":\\"{args[3]}\\",\\"meta\\":{{\\"reviewer\\":\\"{args[2]}\\"}}}}");
if (get.RootElement.GetProperty("result").GetProperty(args[3]).GetProperty("name").GetString() != "Ada" || !find.RootElement.GetProperty("result").TryGetProperty(args[3], out _) || meta.RootElement.GetProperty("result").GetProperty("reviewer").GetString() != args[2]) throw new Exception("csharp client corpus mismatch");
Console.Write(db.PutData("users", new Dictionary<string, object> { ["environment"] = "csharp" }).GetString());
`
    )
    return probe('csharp', 'dotnet', (binary, database, reviewer, identifier, env, environment) =>
        command(
            [
                'dotnet',
                'run',
                '--project',
                directory,
                '--',
                binary,
                database,
                reviewer,
                identifier,
                env
            ],
            { env: environment }
        )
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
  var nulRejected = false;
  try {
    await Fylo.open(args[1], binary: args[0], env: {
      'FYLO_ENCRYPTION_KEY': ${JSON.stringify(secretSentinel)} + String.fromCharCode(0) + 'tail'
    });
  } on ArgumentError catch (error) {
    final message = error.toString();
    nulRejected = message.contains('FYLO_ENCRYPTION_KEY') && !message.contains(${JSON.stringify(secretSentinel)});
  }
  if (!nulRejected) throw StateError('dart NUL environment value was accepted or leaked');
  final environment = args[4] == ${JSON.stringify(unsetEnvironment)}
      ? <String, String?>{'FYLO_SHARD_WIDTH': null}
      : args[4];
  final db = await Fylo.open(args[1], binary: args[0], env: environment);
  try {
    if (args[4] == ${JSON.stringify(unsetEnvironment)}) {
      await db.createCollection('users');
      stdout.write(await db.putData('users', {'environment':'dart-unset'}));
      return;
    }
    final get = await db.request({'op':'getLatest','collection':'users','id':args[3]});
    final find = await db.request({'op':'findDocs','collection':'users','query':{r'$ops':[{'role':{r'$eq':'admin'}}]}});
    final meta = await db.request({'op':'setMeta','collection':'users','id':args[3],'meta':{'reviewer':args[2]}});
    if (get['result'][args[3]]['name'] != 'Ada' || find['result'].length != 1 || meta['result']['reviewer'] != args[2]) throw StateError('dart client corpus mismatch');
    stdout.write(await db.putData('users', {'environment':'dart'}));
  } finally { await db.close(); }
}
`
    )
    return probe('dart', 'dart', (binary, database, reviewer, identifier, env, environment) =>
        command(
            [
                'dart',
                'run',
                sourcePath(directory, 'probe.dart'),
                binary,
                database,
                reviewer,
                identifier,
                env
            ],
            { env: environment }
        )
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
            PYTHONDONTWRITEBYTECODE: '1',
            ...options.env
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
