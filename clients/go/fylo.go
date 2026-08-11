// Package fylo drives the `fylo` binary's persistent NDJSON loop.
//
// Stdlib only. Requires the `fylo` binary on PATH (brew/scoop) or an explicit
// path. One long-lived subprocess keeps the engine warm across calls.
//
//	db, _ := fylo.Open("/path/to/db", "fylo")
//	defer db.Close()
//	db.CreateCollection("users", "document")
//	id, _ := db.PutData("users", map[string]any{"name": "Ada", "role": "admin"})
//	doc, _ := db.GetLatest("users", id.(string))
//	admins, _ := db.FindDocs("users", map[string]any{
//		"$ops": []any{map[string]any{"role": map[string]any{"$eq": "admin"}}}})
//
// Each operation method builds the request and returns the op's `result`
// (or an error if the op failed). Method names mirror the machine-protocol op
// names in Go's exported PascalCase. Request(op) remains a raw escape hatch
// returning the full response — use it for ops without a dedicated method.
package fylo

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

const (
	maxRequestBytes  = 1024 * 1024
	maxResponseBytes = 8 * 1024 * 1024
)

type Fylo struct {
	cmd  *exec.Cmd
	pipe io.WriteCloser
	in   *bufio.Writer
	out  *bufio.Reader
	mu   sync.Mutex
}

// Environment configures only the spawned FYLO process. File and Values are
// mutually exclusive; a nil value removes an inherited variable.
type Environment struct {
	File   string
	Values map[string]*string
}

// Options configures the binary-backed client without changing the host process.
type Options struct {
	Binary string
	Env    *Environment
}

// QueueConsumerOptions configures one bounded decorated invocation.
type QueueConsumerOptions struct {
	MaxMessages         int
	VisibilityTimeoutMs int
	MaxAttempts         int
	RetryDelayMs        int
}

// QueueProcessResult summarizes how a decorated batch was settled.
type QueueProcessResult struct {
	Claimed      int
	Acknowledged int
	Retried      int
	DeadLettered int
}

// QueueHandler processes one native delivery object.
type QueueHandler func(delivery map[string]any) error

// Open starts a warm fylo process rooted at root. binary defaults to "fylo".
func Open(root, binary string) (*Fylo, error) {
	return OpenWithOptions(root, Options{Binary: binary})
}

// OpenWithOptions starts a warm FYLO process with child-scoped configuration.
func OpenWithOptions(root string, options Options) (*Fylo, error) {
	binary := options.Binary
	if binary == "" {
		binary = "fylo"
	}
	args := []string{
		"exec", "--loop", "--root", root,
		"--max-request-bytes", strconv.Itoa(maxRequestBytes),
		"--max-response-bytes", strconv.Itoa(maxResponseBytes),
	}
	cmd := exec.Command(binary, args...)
	environment, err := childEnvironment(options.Env)
	if err != nil {
		return nil, err
	}
	cmd.Env = environment
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &Fylo{
		cmd: cmd, pipe: stdin, in: bufio.NewWriter(stdin),
		out: bufio.NewReaderSize(stdout, maxResponseBytes+2),
	}, nil
}

func childEnvironment(config *Environment) ([]string, error) {
	if config == nil {
		return nil, nil
	}
	if config.File != "" && config.Values != nil {
		return nil, fmt.Errorf("FYLO env File and Values are mutually exclusive")
	}
	overrides := config.Values
	if config.File != "" {
		var err error
		overrides, err = environmentFile(config.File)
		if err != nil {
			return nil, err
		}
	}
	values := make(map[string]string)
	names := make(map[string]string)
	for _, entry := range os.Environ() {
		separator := strings.IndexByte(entry, '=')
		if separator < 1 {
			continue
		}
		name := entry[:separator]
		canonical := environmentName(name)
		names[canonical] = name
		values[canonical] = entry[separator+1:]
	}
	for name, value := range overrides {
		if name == "" || strings.ContainsAny(name, "=\x00") {
			return nil, fmt.Errorf("invalid environment variable name %q", name)
		}
		canonical := environmentName(name)
		if value == nil {
			delete(names, canonical)
			delete(values, canonical)
			continue
		}
		if strings.ContainsRune(*value, '\x00') {
			return nil, fmt.Errorf("invalid environment variable value for %q: contains NUL", name)
		}
		names[canonical] = name
		values[canonical] = *value
	}
	environment := make([]string, 0, len(values))
	for canonical, value := range values {
		environment = append(environment, names[canonical]+"="+value)
	}
	return environment, nil
}

func environmentName(name string) string {
	if runtime.GOOS == "windows" {
		return strings.ToUpper(name)
	}
	return name
}

func environmentFile(path string) (map[string]*string, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read FYLO environment file %s: %w", path, err)
	}
	source := strings.TrimPrefix(string(contents), "\ufeff")
	values := make(map[string]*string)
	for index, original := range strings.Split(strings.ReplaceAll(source, "\r\n", "\n"), "\n") {
		line := index + 1
		entry := strings.TrimSpace(original)
		if entry == "" || strings.HasPrefix(entry, "#") {
			continue
		}
		if strings.HasPrefix(entry, "export") && len(entry) > 6 && (entry[6] == ' ' || entry[6] == '\t') {
			entry = strings.TrimLeft(entry[7:], " \t")
		}
		separator := strings.IndexByte(entry, '=')
		if separator < 0 {
			return nil, fmt.Errorf("%s:%d: expected NAME=VALUE", path, line)
		}
		name := strings.TrimSpace(entry[:separator])
		if !validEnvironmentName(name) {
			return nil, fmt.Errorf("%s:%d: invalid environment variable name %q", path, line, name)
		}
		input := strings.TrimLeft(entry[separator+1:], " \t")
		value, err := environmentValue(path, line, input)
		if err != nil {
			return nil, err
		}
		valueCopy := value
		values[name] = &valueCopy
	}
	return values, nil
}

func validEnvironmentName(name string) bool {
	for index, character := range name {
		if (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || character == '_' || (index > 0 && character >= '0' && character <= '9') {
			continue
		}
		return false
	}
	return name != ""
}

func environmentValue(path string, line int, input string) (string, error) {
	if input == "" || (input[0] != '"' && input[0] != '\'') {
		if comment := strings.IndexByte(input, '#'); comment >= 0 {
			input = input[:comment]
		}
		return strings.TrimRight(input, " \t"), nil
	}
	quote := input[0]
	var value strings.Builder
	for index := 1; index < len(input); index++ {
		character := input[index]
		if character == quote {
			trailing := strings.TrimSpace(input[index+1:])
			if trailing != "" && !strings.HasPrefix(trailing, "#") {
				return "", fmt.Errorf("%s:%d: unexpected characters after quoted value", path, line)
			}
			return value.String(), nil
		}
		if quote == '"' && character == '\\' {
			index++
			if index >= len(input) {
				return "", fmt.Errorf("%s:%d: unterminated escape sequence", path, line)
			}
			escaped := input[index]
			switch escaped {
			case 'n':
				value.WriteByte('\n')
			case 'r':
				value.WriteByte('\r')
			case 't':
				value.WriteByte('\t')
			case '"', '\\':
				value.WriteByte(escaped)
			default:
				value.WriteByte('\\')
				value.WriteByte(escaped)
			}
			continue
		}
		value.WriteByte(character)
	}
	return "", fmt.Errorf("%s:%d: unterminated quoted value", path, line)
}

// op builds a request, sends it, and returns `result` (or an error on failure).
func (f *Fylo) op(name string, fields map[string]any) (any, error) {
	payload := map[string]any{"op": name}
	for k, v := range fields {
		if v != nil {
			payload[k] = v
		}
	}
	resp, err := f.Request(payload)
	if err != nil {
		return nil, err
	}
	if ok, _ := resp["ok"].(bool); !ok {
		msg := "fylo error"
		if e, ok := resp["error"].(map[string]any); ok {
			if m, ok := e["message"].(string); ok {
				msg = m
			}
		}
		return nil, fmt.Errorf("%s", msg)
	}
	return resp["result"], nil
}

// --- Collections ---

func (f *Fylo) CreateCollection(collection, kind string) (any, error) {
	if kind == "" {
		kind = "document"
	}
	return f.op("createCollection", map[string]any{"collection": collection, "kind": kind})
}
func (f *Fylo) DropCollection(collection string) (any, error) {
	return f.op("dropCollection", map[string]any{"collection": collection})
}
func (f *Fylo) InspectCollection(collection string) (any, error) {
	return f.op("inspectCollection", map[string]any{"collection": collection})
}
func (f *Fylo) RebuildCollection(collection string) (any, error) {
	return f.op("rebuildCollection", map[string]any{"collection": collection})
}

// Durable serverless queue.
func (f *Fylo) QueuePublish(topic string, payload any, options map[string]any) (any, error) {
	fields := map[string]any{"topic": topic, "payload": payload}
	copyQueueOptions(fields, options, "delayMs", "idempotencyKey")
	return f.op("queuePublish", fields)
}
func (f *Fylo) QueueClaim(topic, group string, options map[string]any) (any, error) {
	fields := map[string]any{"topic": topic, "group": group}
	copyQueueOptions(fields, options, "maxMessages", "visibilityTimeoutMs", "maxAttempts")
	return f.op("queueClaim", fields)
}
func (f *Fylo) QueueAck(topic, group, id, receipt string) (any, error) {
	return f.op("queueAck", map[string]any{"topic": topic, "group": group, "id": id, "receipt": receipt})
}
func (f *Fylo) QueueNack(topic, group, id, receipt string, options map[string]any) (any, error) {
	fields := map[string]any{"topic": topic, "group": group, "id": id, "receipt": receipt}
	copyQueueOptions(fields, options, "delayMs", "reason")
	return f.op("queueNack", fields)
}
func (f *Fylo) QueueExtend(topic, group, id, receipt string, visibilityTimeoutMs int) (any, error) {
	return f.op("queueExtend", map[string]any{"topic": topic, "group": group, "id": id, "receipt": receipt, "visibilityTimeoutMs": visibilityTimeoutMs})
}
func (f *Fylo) QueueStats(topic, group string) (any, error) {
	return f.op("queueStats", map[string]any{"topic": topic, "group": group})
}
func (f *Fylo) QueueDeadLetters(topic, group string, limit int) (any, error) {
	return f.op("queueDeadLetters", map[string]any{"topic": topic, "group": group, "limit": limit})
}

// copyQueueOptions ignores unknown and protected request fields by construction.
func copyQueueOptions(fields, options map[string]any, allowed ...string) {
	for _, key := range allowed {
		if value, ok := options[key]; ok {
			fields[key] = value
		}
	}
}

// QueueProcess claims and settles one bounded batch. Handler errors are nacked.
func (f *Fylo) QueueProcess(topic, group string, handler QueueHandler, options QueueConsumerOptions) (QueueProcessResult, error) {
	if handler == nil {
		return QueueProcessResult{}, fmt.Errorf("queue handler is required")
	}
	if options.MaxMessages == 0 {
		options.MaxMessages = 1
	}
	if options.VisibilityTimeoutMs == 0 {
		options.VisibilityTimeoutMs = 30000
	}
	if options.MaxAttempts == 0 {
		options.MaxAttempts = 3
	}
	claimed, err := f.QueueClaim(topic, group, map[string]any{
		"maxMessages":         options.MaxMessages,
		"visibilityTimeoutMs": options.VisibilityTimeoutMs,
		"maxAttempts":         options.MaxAttempts,
	})
	if err != nil {
		return QueueProcessResult{}, err
	}
	deliveries, ok := claimed.([]any)
	if !ok {
		return QueueProcessResult{}, fmt.Errorf("fylo queue claim returned an invalid delivery list")
	}
	result := QueueProcessResult{Claimed: len(deliveries)}
	for _, item := range deliveries {
		delivery, ok := item.(map[string]any)
		if !ok {
			return result, fmt.Errorf("fylo queue claim returned an invalid delivery")
		}
		id, idOK := delivery["id"].(string)
		receipt, receiptOK := delivery["receipt"].(string)
		if !idOK || !receiptOK {
			return result, fmt.Errorf("fylo queue delivery lacks an id or receipt")
		}
		if handler(delivery) == nil {
			if _, err := f.QueueAck(topic, group, id, receipt); err != nil {
				return result, err
			}
			result.Acknowledged++
		} else {
			settled, err := f.QueueNack(topic, group, id, receipt, map[string]any{
				"delayMs": options.RetryDelayMs,
				"reason":  "queue handler failed",
			})
			if err != nil {
				return result, err
			}
			outcome, _ := settled.(map[string]any)
			if dead, _ := outcome["deadLettered"].(bool); dead {
				result.DeadLettered++
			} else {
				result.Retried++
			}
		}
	}
	return result, nil
}

// QueueConsumer returns Go's decorator-equivalent one-batch handler wrapper.
func (f *Fylo) QueueConsumer(topic, group string, handler QueueHandler, options QueueConsumerOptions) func() (QueueProcessResult, error) {
	return func() (QueueProcessResult, error) {
		return f.QueueProcess(topic, group, handler, options)
	}
}

// --- Documents ---

func (f *Fylo) PutData(collection string, data map[string]any) (any, error) {
	return f.op("putData", map[string]any{"collection": collection, "data": data})
}
func (f *Fylo) BatchPutData(collection string, batch []any) (any, error) {
	return f.op("batchPutData", map[string]any{"collection": collection, "batch": batch})
}
func (f *Fylo) GetDoc(collection, id string) (any, error) {
	return f.op("getDoc", map[string]any{"collection": collection, "id": id})
}
func (f *Fylo) GetMeta(collection, id string) (any, error) {
	return f.op("getMeta", map[string]any{"collection": collection, "id": id})
}
func (f *Fylo) SetMeta(collection, id string, meta map[string]any) (any, error) {
	return f.op("setMeta", map[string]any{"collection": collection, "id": id, "meta": meta})
}
func (f *Fylo) GetLatest(collection, id string) (any, error) {
	return f.op("getLatest", map[string]any{"collection": collection, "id": id})
}
func (f *Fylo) PatchDoc(collection, id string, newDoc map[string]any) (any, error) {
	return f.op("patchDoc", map[string]any{"collection": collection, "id": id, "newDoc": newDoc})
}
func (f *Fylo) PatchDocs(collection string, update map[string]any) (any, error) {
	return f.op("patchDocs", map[string]any{"collection": collection, "update": update})
}
func (f *Fylo) DelDoc(collection, id string) (any, error) {
	return f.op("delDoc", map[string]any{"collection": collection, "id": id})
}
func (f *Fylo) DelDocs(collection string, criteria map[string]any) (any, error) {
	return f.op("delDocs", map[string]any{"collection": collection, "delete": criteria})
}
func (f *Fylo) RestoreDoc(collection, id string) (any, error) {
	return f.op("restoreDoc", map[string]any{"collection": collection, "id": id})
}

// --- Query ---

func (f *Fylo) FindDocs(collection string, query map[string]any) (any, error) {
	return f.op("findDocs", map[string]any{"collection": collection, "query": query})
}
func (f *Fylo) FindDeletedDocs(collection string, query map[string]any) (any, error) {
	return f.op("findDeletedDocs", map[string]any{"collection": collection, "query": query})
}
func (f *Fylo) FindDocsPage(collection string, query, page map[string]any) (any, error) {
	return f.op("findDocs", map[string]any{"collection": collection, "query": query, "page": page})
}
func (f *Fylo) FindDeletedDocsPage(collection string, query, page map[string]any) (any, error) {
	return f.op("findDeletedDocs", map[string]any{"collection": collection, "query": query, "page": page})
}
func (f *Fylo) JoinDocs(join map[string]any) (any, error) {
	return f.op("joinDocs", map[string]any{"join": join})
}
func (f *Fylo) ExecuteSQL(sql string, access ...map[string]any) (any, error) {
	fields := map[string]any{"sql": sql}
	if len(access) > 0 {
		fields["access"] = access[0]
	}
	return f.op("executeSQL", fields)
}

// Sql runs raw SQL, built with fmt.Sprintf. Values are inlined verbatim —
// escape/validate untrusted input yourself.
func (f *Fylo) Sql(query string, access ...map[string]any) (any, error) {
	return f.ExecuteSQL(query, access...)
}
func (f *Fylo) ImportBulkData(collection, url string) (any, error) {
	return f.op("importBulkData", map[string]any{"collection": collection, "url": url})
}

// Request sends one raw machine-protocol op and returns the full response.
func (f *Fylo) Request(op map[string]any) (map[string]any, error) {
	line, err := json.Marshal(op)
	if err != nil {
		return nil, err
	}
	if len(line) > maxRequestBytes {
		return nil, fmt.Errorf("FYLO request exceeds %d bytes", maxRequestBytes)
	}
	f.mu.Lock() // ponytail: one call in flight; drop the lock only if you pipeline
	defer f.mu.Unlock()
	if _, err := f.in.Write(append(line, '\n')); err != nil {
		return nil, err
	}
	if err := f.in.Flush(); err != nil {
		return nil, err
	}
	reply, err := f.out.ReadSlice('\n')
	if err != nil || len(reply) == 0 || reply[len(reply)-1] != '\n' || len(reply)-1 > maxResponseBytes {
		_ = f.cmd.Process.Kill()
		if err != nil {
			return nil, fmt.Errorf("fylo response framing failed: %w", err)
		}
		return nil, fmt.Errorf("FYLO response exceeds %d bytes", maxResponseBytes)
	}
	var resp map[string]any
	if err := json.Unmarshal(reply, &resp); err != nil {
		_ = f.cmd.Process.Kill()
		return nil, err
	}
	return resp, nil
}

// Close ends the process by closing stdin and waiting for exit.
func (f *Fylo) Close() error {
	_ = f.pipe.Close()
	return f.cmd.Wait()
}

// Collection returns a collection-scoped facade with short method names, so
// db.Collection("users").Put(data) reads like the browser client.
func (f *Fylo) Collection(name string) *Collection {
	return &Collection{fylo: f, name: name}
}

// Collection is a collection-scoped view; methods drop the leading collection arg.
type Collection struct {
	fylo *Fylo
	name string
}

func (c *Collection) Create(kind string) (any, error) { return c.fylo.CreateCollection(c.name, kind) }
func (c *Collection) Drop() (any, error)              { return c.fylo.DropCollection(c.name) }
func (c *Collection) Inspect() (any, error)           { return c.fylo.InspectCollection(c.name) }
func (c *Collection) Rebuild() (any, error)           { return c.fylo.RebuildCollection(c.name) }
func (c *Collection) Put(data map[string]any) (any, error) {
	return c.fylo.PutData(c.name, data)
}
func (c *Collection) Get(id string) (any, error)     { return c.fylo.GetDoc(c.name, id) }
func (c *Collection) GetMeta(id string) (any, error) { return c.fylo.GetMeta(c.name, id) }
func (c *Collection) SetMeta(id string, meta map[string]any) (any, error) {
	return c.fylo.SetMeta(c.name, id, meta)
}
func (c *Collection) Latest(id string) (any, error) { return c.fylo.GetLatest(c.name, id) }
func (c *Collection) Patch(id string, newDoc map[string]any) (any, error) {
	return c.fylo.PatchDoc(c.name, id, newDoc)
}
func (c *Collection) Delete(id string) (any, error)  { return c.fylo.DelDoc(c.name, id) }
func (c *Collection) Restore(id string) (any, error) { return c.fylo.RestoreDoc(c.name, id) }
func (c *Collection) Find(query map[string]any) (any, error) {
	return c.fylo.FindDocs(c.name, query)
}
func (c *Collection) FindPage(query, page map[string]any) (any, error) {
	return c.fylo.FindDocsPage(c.name, query, page)
}
