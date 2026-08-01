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

class Fylo
{
    private const MAX_REQUEST_BYTES = 1048576;
    private const MAX_RESPONSE_BYTES = 8388608;
    private $proc;
    private $stdin;
    private $stdout;

    public function __construct(string $root, string $binary = 'fylo')
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
        $this->proc = proc_open($args, $descriptors, $pipes);
        if (!is_resource($this->proc)) {
            throw new FyloError('failed to start fylo');
        }
        $this->stdin = $pipes[0];
        $this->stdout = $pipes[1];
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
