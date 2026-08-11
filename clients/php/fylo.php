<?php
// Fylo client — drives the `fylo` binary's persistent NDJSON loop.
//
// No Composer dependencies (ext-json is bundled with PHP). Requires the `fylo`
// binary on PATH (brew/scoop) or an explicit path. One long-lived subprocess
// keeps the engine warm across calls.
//
//   require 'fylo.php';
//
//   $db = new Fylo('/path/to/db');
//   $db->createCollection('users');
//   $id = $db->putData('users', ['name' => 'Ada', 'role' => 'admin']);
//   $doc = $db->getLatest('users', $id);
//   $admins = $db->findDocs('users', ['$ops' => [['role' => ['$eq' => 'admin']]]]);
//   $db->close();
//
// Each operation method builds the request and returns the op's `result`
// (throwing FyloError on failure). Method names follow PHP's camelCase
// convention; object arguments are native associative arrays. request($op) is
// the raw escape hatch returning the full decoded response.

class FyloError extends Exception {}

#[Attribute(Attribute::TARGET_METHOD)]
class FyloQueueConsumer
{
    public function __construct(
        public string $topic,
        public string $group,
        public int $maxMessages = 1,
        public int $visibilityTimeoutMs = 30000,
        public int $maxAttempts = 3,
        public int $retryDelayMs = 0,
    ) {}
}

class Fylo
{
    private const MAX_REQUEST_BYTES = 1048576;
    private const MAX_RESPONSE_BYTES = 8388608;
    private $proc;
    private $stdin;
    private $stdout;

    public function __construct(string $root, string $binary = 'fylo', string|array|null $env = null)
    {
        $args = [
            $binary,
            'exec',
            '--loop',
            '--root',
            $root,
            '--max-request-bytes',
            (string) self::MAX_REQUEST_BYTES,
            '--max-response-bytes',
            (string) self::MAX_RESPONSE_BYTES,
        ];
        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', 'php://stderr', 'w']];
        $this->proc = proc_open($args, $descriptors, $pipes, null, self::childEnvironment($env));
        if (!is_resource($this->proc)) {
            throw new FyloError('failed to start fylo');
        }
        $this->stdin = $pipes[0];
        $this->stdout = $pipes[1];
    }

    private static function childEnvironment(string|array|null $config): ?array
    {
        if ($config === null) return null;
        $overrides = is_string($config) ? self::environmentFile($config) : $config;
        $environment = getenv();
        if (!is_array($environment)) $environment = [];
        $windows = PHP_OS_FAMILY === 'Windows';
        if ($windows) {
            $environment = array_combine(
                array_map('strtoupper', array_keys($environment)),
                array_values($environment)
            ) ?: [];
        }
        foreach ($overrides as $name => $value) {
            $name = (string) $name;
            if ($name === '' || str_contains($name, '=') || str_contains($name, "\0")) {
                throw new InvalidArgumentException('invalid environment variable name ' . json_encode($name));
            }
            $environmentName = $windows ? strtoupper($name) : $name;
            if ($value === null) {
                unset($environment[$environmentName]);
            } else {
                $environmentValue = (string) $value;
                if (str_contains($environmentValue, "\0")) {
                    throw new InvalidArgumentException(
                        'invalid environment variable value for ' . json_encode($name) . ': NUL is not allowed'
                    );
                }
                $environment[$environmentName] = $environmentValue;
            }
        }
        return $environment;
    }

    private static function environmentFile(string $path): array
    {
        $lines = @file($path, FILE_IGNORE_NEW_LINES);
        if ($lines === false) throw new FyloError("cannot read FYLO environment file $path");
        $values = [];
        foreach ($lines as $offset => $original) {
            $line = $offset + 1;
            $entry = trim($original);
            if ($offset === 0 && str_starts_with($entry, "\xEF\xBB\xBF")) {
                $entry = substr($entry, 3);
            }
            if ($entry === '' || str_starts_with($entry, '#')) continue;
            $entry = preg_replace('/^export\s+/', '', $entry);
            $separator = strpos($entry, '=');
            if ($separator === false) throw new FyloError("$path:$line: expected NAME=VALUE");
            $name = trim(substr($entry, 0, $separator));
            if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) {
                throw new FyloError("$path:$line: invalid environment variable name " . json_encode($name));
            }
            $input = ltrim(substr($entry, $separator + 1));
            if ($input !== '' && ($input[0] === '"' || $input[0] === "'")) {
                $values[$name] = self::quotedEnvironmentValue($path, $line, $input, $input[0]);
            } else {
                $comment = strpos($input, '#');
                $values[$name] = rtrim($comment === false ? $input : substr($input, 0, $comment));
            }
        }
        return $values;
    }

    private static function quotedEnvironmentValue(string $path, int $line, string $input, string $quote): string
    {
        $value = '';
        $length = strlen($input);
        for ($index = 1; $index < $length; $index++) {
            $character = $input[$index];
            if ($character === $quote) {
                $trailing = trim(substr($input, $index + 1));
                if ($trailing !== '' && !str_starts_with($trailing, '#')) {
                    throw new FyloError("$path:$line: unexpected characters after quoted value");
                }
                return $value;
            }
            if ($quote === '"' && $character === '\\') {
                $index++;
                if ($index >= $length) throw new FyloError("$path:$line: unterminated escape sequence");
                $escaped = $input[$index];
                $value .= ['n' => "\n", 'r' => "\r", 't' => "\t", '"' => '"', '\\' => '\\'][$escaped] ?? "\\$escaped";
            } else {
                $value .= $character;
            }
        }
        throw new FyloError("$path:$line: unterminated quoted value");
    }

    /** Send one raw machine-protocol op; return the full decoded response. */
    public function request(array $op)
    {
        $payload = json_encode($op, JSON_THROW_ON_ERROR);
        if (strlen($payload) > self::MAX_REQUEST_BYTES) {
            throw new FyloError('FYLO request exceeds ' . self::MAX_REQUEST_BYTES . ' bytes');
        }
        fwrite($this->stdin, $payload . "\n");
        fflush($this->stdin);
        $reply = fgets($this->stdout, self::MAX_RESPONSE_BYTES + 2);
        if ($reply === false) {
            throw new FyloError('fylo closed the stream');
        }
        if (substr($reply, -1) !== "\n" || strlen($reply) - 1 > self::MAX_RESPONSE_BYTES) {
            proc_terminate($this->proc, 9);
            throw new FyloError('FYLO response exceeds ' . self::MAX_RESPONSE_BYTES . ' bytes');
        }
        try {
            return json_decode(substr($reply, 0, -1), true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $error) {
            proc_terminate($this->proc, 9);
            throw new FyloError('fylo returned malformed UTF-8 or JSON', 0, $error);
        }
    }

    // --- Collections ---
    public function createCollection(string $collection, string $kind = 'document')
    {
        return $this->op('createCollection', ['collection' => $collection, 'kind' => $kind]);
    }
    public function dropCollection(string $collection)
    {
        return $this->op('dropCollection', ['collection' => $collection]);
    }
    public function inspectCollection(string $collection)
    {
        return $this->op('inspectCollection', ['collection' => $collection]);
    }
    public function rebuildCollection(string $collection)
    {
        return $this->op('rebuildCollection', ['collection' => $collection]);
    }

    // --- Durable serverless queue ---
    public function queuePublish(string $topic, mixed $payload, array $options = [])
    {
        return $this->op(
            'queuePublish',
            ['topic' => $topic, 'payload' => $payload] +
                $this->queueOptions($options, ['delayMs', 'idempotencyKey']),
        );
    }
    public function queueClaim(string $topic, string $group, array $options = [])
    {
        return $this->op(
            'queueClaim',
            ['topic' => $topic, 'group' => $group] +
                $this->queueOptions($options, ['maxMessages', 'visibilityTimeoutMs', 'maxAttempts']),
        );
    }
    public function queueAck(string $topic, string $group, string $id, string $receipt)
    {
        return $this->op('queueAck', compact('topic', 'group', 'id', 'receipt'));
    }
    public function queueNack(string $topic, string $group, string $id, string $receipt, array $options = [])
    {
        return $this->op(
            'queueNack',
            compact('topic', 'group', 'id', 'receipt') +
                $this->queueOptions($options, ['delayMs', 'reason']),
        );
    }
    public function queueExtend(string $topic, string $group, string $id, string $receipt, int $visibilityTimeoutMs = 30000)
    {
        return $this->op('queueExtend', compact('topic', 'group', 'id', 'receipt', 'visibilityTimeoutMs'));
    }
    public function queueStats(string $topic, string $group)
    {
        return $this->op('queueStats', compact('topic', 'group'));
    }
    public function queueDeadLetters(string $topic, string $group, int $limit = 100)
    {
        return $this->op('queueDeadLetters', compact('topic', 'group', 'limit'));
    }
    /** Process and settle one bounded queue batch. */
    public function queueProcess(string $topic, string $group, callable $handler, array $options = []): array
    {
        $claimOptions = [
            'maxMessages' => $options['maxMessages'] ?? 1,
            'visibilityTimeoutMs' => $options['visibilityTimeoutMs'] ?? 30000,
            'maxAttempts' => $options['maxAttempts'] ?? 3,
        ];
        $deliveries = $this->queueClaim($topic, $group, $claimOptions);
        $result = [
            'claimed' => count($deliveries),
            'acknowledged' => 0,
            'retried' => 0,
            'deadLettered' => 0,
        ];
        foreach ($deliveries as $delivery) {
            $failed = false;
            try {
                $handler($delivery);
            } catch (Throwable) {
                $failed = true;
            }
            if (!$failed) {
                $this->queueAck($topic, $group, $delivery['id'], $delivery['receipt']);
                $result['acknowledged']++;
            } else {
                $settled = $this->queueNack(
                    $topic,
                    $group,
                    $delivery['id'],
                    $delivery['receipt'],
                    [
                        'delayMs' => $options['retryDelayMs'] ?? 0,
                        'reason' => 'queue handler failed',
                    ],
                );
                $result[!empty($settled['deadLettered']) ? 'deadLettered' : 'retried']++;
            }
        }
        return $result;
    }
    /** Return a callable decorator equivalent for languages without @ syntax. */
    public function queueConsumer(string $topic, string $group, callable $handler, array $options = []): Closure
    {
        return fn (...$args) => $this->queueProcess(
            $topic,
            $group,
            fn ($delivery) => $handler($delivery, ...$args),
            $options,
        );
    }
    /** Run a method configured with #[FyloQueueConsumer(...)]. */
    public function runQueueConsumer(object $target, string $method): array
    {
        $reflection = new ReflectionMethod($target, $method);
        $attributes = $reflection->getAttributes(FyloQueueConsumer::class);
        if (count($attributes) !== 1) {
            throw new FyloError('queue consumer method must have exactly one FyloQueueConsumer attribute');
        }
        $consumer = $attributes[0]->newInstance();
        return $this->queueProcess(
            $consumer->topic,
            $consumer->group,
            fn ($delivery) => $reflection->invoke($target, $delivery),
            [
                'maxMessages' => $consumer->maxMessages,
                'visibilityTimeoutMs' => $consumer->visibilityTimeoutMs,
                'maxAttempts' => $consumer->maxAttempts,
                'retryDelayMs' => $consumer->retryDelayMs,
            ],
        );
    }

    // --- Documents ---
    public function putData(string $collection, array $data)
    {
        return $this->op('putData', ['collection' => $collection, 'data' => $data]);
    }
    public function batchPutData(string $collection, array $batch)
    {
        return $this->op('batchPutData', ['collection' => $collection, 'batch' => $batch]);
    }
    public function getDoc(string $collection, string $id)
    {
        return $this->op('getDoc', ['collection' => $collection, 'id' => $id]);
    }
    public function getMeta(string $collection, string $id)
    {
        return $this->op('getMeta', ['collection' => $collection, 'id' => $id]);
    }
    public function setMeta(string $collection, string $id, array $meta)
    {
        return $this->op('setMeta', ['collection' => $collection, 'id' => $id, 'meta' => $meta]);
    }
    public function getLatest(string $collection, string $id)
    {
        return $this->op('getLatest', ['collection' => $collection, 'id' => $id]);
    }
    public function patchDoc(string $collection, string $id, array $newDoc)
    {
        return $this->op('patchDoc', ['collection' => $collection, 'id' => $id, 'newDoc' => $newDoc]);
    }
    public function patchDocs(string $collection, array $update)
    {
        return $this->op('patchDocs', ['collection' => $collection, 'update' => $update]);
    }
    public function delDoc(string $collection, string $id)
    {
        return $this->op('delDoc', ['collection' => $collection, 'id' => $id]);
    }
    public function delDocs(string $collection, array $criteria)
    {
        return $this->op('delDocs', ['collection' => $collection, 'delete' => $criteria]);
    }
    public function restoreDoc(string $collection, string $id)
    {
        return $this->op('restoreDoc', ['collection' => $collection, 'id' => $id]);
    }

    // --- Query ---
    public function findDocs(string $collection, array $query)
    {
        return $this->op('findDocs', ['collection' => $collection, 'query' => $query]);
    }
    public function findDeletedDocs(string $collection, array $query = [])
    {
        return $this->op('findDeletedDocs', ['collection' => $collection, 'query' => $query]);
    }
    public function findDocsPage(string $collection, array $query, array $page = [])
    {
        return $this->op('findDocs', ['collection' => $collection, 'query' => $query, 'page' => $page]);
    }
    public function findDeletedDocsPage(string $collection, array $query = [], array $page = [])
    {
        return $this->op('findDeletedDocs', ['collection' => $collection, 'query' => $query, 'page' => $page]);
    }
    public function joinDocs(array $join)
    {
        return $this->op('joinDocs', ['join' => $join]);
    }
    public function executeSQL(string $sql, ?array $access = null)
    {
        return $this->op('executeSQL', ['sql' => $sql, 'access' => $access]);
    }

    // Run raw SQL, built with native interpolation: $db->sql("... $x").
    // Values are inlined verbatim — escape/validate untrusted input yourself.
    public function sql(string $query, ?array $access = null)
    {
        return $this->executeSQL($query, $access);
    }
    public function importBulkData(string $collection, string $url)
    {
        return $this->op('importBulkData', ['collection' => $collection, 'url' => $url]);
    }

    // Collection-scoped facade: $db->collection('users')->put($data). The sugar
    // $db->users->put($data) resolves through __get to the same thing.
    public function collection(string $name): FyloCollection
    {
        return new FyloCollection($this, $name);
    }

    public function __get(string $name): FyloCollection
    {
        return new FyloCollection($this, $name);
    }

    public function close(): void
    {
        if (is_resource($this->proc)) {
            fclose($this->stdin); // EOF ends the loop
            proc_close($this->proc);
        }
    }

    private function op(string $name, array $fields)
    {
        $payload = ['op' => $name];
        foreach ($fields as $key => $value) {
            if ($value !== null) {
                $payload[$key] = $value;
            }
        }
        $resp = $this->request($payload);
        if (empty($resp['ok'])) {
            throw new FyloError($resp['error']['message'] ?? 'fylo error');
        }
        return $resp['result'] ?? null;
    }

    /** Copy documented queue options only; unknown and protected fields are ignored. */
    private function queueOptions(array $options, array $allowed): array
    {
        return array_intersect_key($options, array_fill_keys($allowed, true));
    }
}

// A collection-scoped view; methods drop the leading collection argument.
class FyloCollection
{
    private Fylo $db;
    private string $name;

    public function __construct(Fylo $db, string $name)
    {
        $this->db = $db;
        $this->name = $name;
    }

    public function create(string $kind = 'document')
    {
        return $this->db->createCollection($this->name, $kind);
    }
    public function drop()
    {
        return $this->db->dropCollection($this->name);
    }
    public function inspect()
    {
        return $this->db->inspectCollection($this->name);
    }
    public function rebuild()
    {
        return $this->db->rebuildCollection($this->name);
    }
    public function put(array $data)
    {
        return $this->db->putData($this->name, $data);
    }
    public function get(string $id)
    {
        return $this->db->getDoc($this->name, $id);
    }
    public function getMetadata(string $id)
    {
        return $this->db->getMeta($this->name, $id);
    }
    public function setMetadata(string $id, array $meta)
    {
        return $this->db->setMeta($this->name, $id, $meta);
    }
    public function latest(string $id)
    {
        return $this->db->getLatest($this->name, $id);
    }
    public function patch(string $id, array $newDoc)
    {
        return $this->db->patchDoc($this->name, $id, $newDoc);
    }
    public function delete(string $id)
    {
        return $this->db->delDoc($this->name, $id);
    }
    public function restore(string $id)
    {
        return $this->db->restoreDoc($this->name, $id);
    }
    public function find(array $query)
    {
        return $this->db->findDocs($this->name, $query);
    }
    public function findPage(array $query, array $page = [])
    {
        return $this->db->findDocsPage($this->name, $query, $page);
    }
}
