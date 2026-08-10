// Fylo client — drives the `fylo` binary's persistent NDJSON loop.
//
// No NuGet dependencies (System.Text.Json ships with .NET). Requires the `fylo`
// binary on PATH (brew/scoop) or an explicit path. One long-lived subprocess
// keeps the engine warm across calls.
//
//   using var db = new Fylo("/path/to/db");
//   var data = new Dictionary<string, object> { ["name"] = "Ada", ["role"] = "admin" };
//   string id = db.PutData("users", data).GetString();
//   JsonElement doc = db.GetLatest("users", id);
//   JsonElement admins = db.FindDocs("users", new Dictionary<string, object>
//       { ["$ops"] = new object[] { new Dictionary<string, object>
//           { ["role"] = new Dictionary<string, object> { ["$eq"] = "admin" } } } });
//
// Each operation method builds the request and returns the op's `result` as a
// JsonElement (throwing FyloException on failure). Method names follow .NET
// PascalCase; object arguments are native objects (Dictionary/arrays), serialized
// with System.Text.Json. Request(json) is the raw escape hatch.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace Fylo
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
    public sealed class FyloQueueConsumerAttribute : Attribute
    {
        public string Topic { get; }
        public string Group { get; }
        public int MaxMessages { get; set; } = 1;
        public int VisibilityTimeoutMs { get; set; } = 30000;
        public int MaxAttempts { get; set; } = 3;
        public int RetryDelayMs { get; set; } = 0;

        public FyloQueueConsumerAttribute(string topic, string group)
        {
            Topic = topic;
            Group = group;
        }
    }

    public sealed class QueueProcessResult
    {
        public int Claimed { get; internal set; }
        public int Acknowledged { get; internal set; }
        public int Retried { get; internal set; }
        public int DeadLettered { get; internal set; }
    }

    public sealed class FyloException : Exception
    {
        public FyloException(string message) : base(message) { }
    }

    public sealed class Fylo : IDisposable
    {
        private const int MaxRequestBytes = 1024 * 1024;
        private const int MaxResponseBytes = 8 * 1024 * 1024;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private readonly Process _proc;
        private readonly Stream _stdout;
        private readonly byte[] _responseBuffer = new byte[MaxResponseBytes + 1];
        private readonly object _lock = new object();

        public Fylo(string root, string binary = "fylo")
        {
            var psi = new ProcessStartInfo
            {
                FileName = binary,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                // Protocol is UTF-8; don't fall back to the Windows console code page.
                StandardInputEncoding = new UTF8Encoding(false),
                StandardOutputEncoding = new UTF8Encoding(false),
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--loop");
            psi.ArgumentList.Add("--root");
            psi.ArgumentList.Add(root);
            psi.ArgumentList.Add("--max-request-bytes");
            psi.ArgumentList.Add(MaxRequestBytes.ToString());
            psi.ArgumentList.Add("--max-response-bytes");
            psi.ArgumentList.Add(MaxResponseBytes.ToString());
            _proc = Process.Start(psi) ?? throw new InvalidOperationException("failed to start fylo");
            _stdout = _proc.StandardOutput.BaseStream;
        }

        /// <summary>Send one raw machine-protocol op (JSON string); returns the full response.</summary>
        public JsonDocument Request(string opJson)
        {
            lock (_lock) // ponytail: one call in flight; drop the lock only if you pipeline
            {
                if (_proc.HasExited) throw new InvalidOperationException("fylo process has exited");
                string payload = opJson.TrimEnd();
                if (Encoding.UTF8.GetByteCount(payload) > MaxRequestBytes)
                    throw new FyloException($"FYLO request exceeds {MaxRequestBytes} bytes");
                _proc.StandardInput.Write(payload);
                _proc.StandardInput.Write('\n');
                _proc.StandardInput.Flush();
                int length = 0;
                while (length <= MaxResponseBytes)
                {
                    int next = _stdout.ReadByte();
                    if (next < 0) throw new InvalidOperationException("fylo closed the stream");
                    if (next == '\n')
                    {
                        try
                        {
                            string line = StrictUtf8.GetString(_responseBuffer, 0, length);
                            return JsonDocument.Parse(line);
                        }
                        catch (Exception error) when (
                            error is DecoderFallbackException || error is JsonException)
                        {
                            _proc.Kill();
                            throw new FyloException("fylo returned malformed UTF-8 or JSON");
                        }
                    }
                    _responseBuffer[length++] = (byte)next;
                }
                _proc.Kill();
                throw new FyloException($"FYLO response exceeds {MaxResponseBytes} bytes");
            }
        }

        // Send a fully-formed op JSON and return `result`, throwing on failure.
        private JsonElement Op(string opJson)
        {
            using JsonDocument doc = Request(opJson);
            JsonElement root = doc.RootElement;
            if (!root.GetProperty("ok").GetBoolean())
            {
                string msg = root.TryGetProperty("error", out var e) &&
                             e.TryGetProperty("message", out var m)
                    ? m.GetString() ?? "fylo error"
                    : "fylo error";
                throw new FyloException(msg);
            }
            return root.TryGetProperty("result", out var r) ? r.Clone() : default;
        }

        // Serialize any native value to JSON (e.g. "users" -> "users", a
        // Dictionary -> a JSON object). Object arguments below rely on this.
        private static string J(object value) => JsonSerializer.Serialize(value);

        // --- Collections ---
        public JsonElement CreateCollection(string collection, string kind = "document") =>
            Op($"{{\"op\":\"createCollection\",\"collection\":{J(collection)},\"kind\":{J(kind)}}}");
        public JsonElement DropCollection(string collection) =>
            Op($"{{\"op\":\"dropCollection\",\"collection\":{J(collection)}}}");
        public JsonElement InspectCollection(string collection) =>
            Op($"{{\"op\":\"inspectCollection\",\"collection\":{J(collection)}}}");
        public JsonElement RebuildCollection(string collection) =>
            Op($"{{\"op\":\"rebuildCollection\",\"collection\":{J(collection)}}}");

        // --- Durable serverless queue ---
        public JsonElement QueuePublish(string topic, object payload, int delayMs = 0, string idempotencyKey = null) =>
            Op(idempotencyKey == null
                ? $"{{\"op\":\"queuePublish\",\"topic\":{J(topic)},\"payload\":{J(payload)},\"delayMs\":{delayMs}}}"
                : $"{{\"op\":\"queuePublish\",\"topic\":{J(topic)},\"payload\":{J(payload)},\"delayMs\":{delayMs},\"idempotencyKey\":{J(idempotencyKey)}}}");
        public JsonElement QueueClaim(string topic, string group, int maxMessages = 1, int visibilityTimeoutMs = 30000, int maxAttempts = 3) =>
            Op($"{{\"op\":\"queueClaim\",\"topic\":{J(topic)},\"group\":{J(group)},\"maxMessages\":{maxMessages},\"visibilityTimeoutMs\":{visibilityTimeoutMs},\"maxAttempts\":{maxAttempts}}}");
        public JsonElement QueueAck(string topic, string group, string id, string receipt) =>
            Op($"{{\"op\":\"queueAck\",\"topic\":{J(topic)},\"group\":{J(group)},\"id\":{J(id)},\"receipt\":{J(receipt)}}}");
        public JsonElement QueueNack(string topic, string group, string id, string receipt, int delayMs = 0, string reason = "") =>
            Op($"{{\"op\":\"queueNack\",\"topic\":{J(topic)},\"group\":{J(group)},\"id\":{J(id)},\"receipt\":{J(receipt)},\"delayMs\":{delayMs},\"reason\":{J(reason)}}}");
        public JsonElement QueueExtend(string topic, string group, string id, string receipt, int visibilityTimeoutMs = 30000) =>
            Op($"{{\"op\":\"queueExtend\",\"topic\":{J(topic)},\"group\":{J(group)},\"id\":{J(id)},\"receipt\":{J(receipt)},\"visibilityTimeoutMs\":{visibilityTimeoutMs}}}");
        public JsonElement QueueStats(string topic, string group) =>
            Op($"{{\"op\":\"queueStats\",\"topic\":{J(topic)},\"group\":{J(group)}}}");
        public JsonElement QueueDeadLetters(string topic, string group, int limit = 100) =>
            Op($"{{\"op\":\"queueDeadLetters\",\"topic\":{J(topic)},\"group\":{J(group)},\"limit\":{limit}}}");

        /// <summary>Process and settle one bounded queue batch.</summary>
        public QueueProcessResult QueueProcess(
            string topic,
            string group,
            Action<JsonElement> handler,
            int maxMessages = 1,
            int visibilityTimeoutMs = 30000,
            int maxAttempts = 3,
            int retryDelayMs = 0)
        {
            if (handler == null) throw new ArgumentNullException(nameof(handler));
            JsonElement deliveries = QueueClaim(topic, group, maxMessages, visibilityTimeoutMs, maxAttempts);
            if (deliveries.ValueKind != JsonValueKind.Array)
                throw new FyloException("fylo queue claim returned an invalid delivery list");
            var result = new QueueProcessResult { Claimed = deliveries.GetArrayLength() };
            foreach (JsonElement delivery in deliveries.EnumerateArray())
            {
                string id = delivery.GetProperty("id").GetString()
                    ?? throw new FyloException("queue delivery lacks an id");
                string receipt = delivery.GetProperty("receipt").GetString()
                    ?? throw new FyloException("queue delivery lacks a receipt");
                bool failed = false;
                try
                {
                    handler(delivery.Clone());
                }
                catch (Exception)
                {
                    failed = true;
                }
                if (!failed)
                {
                    QueueAck(topic, group, id, receipt);
                    result.Acknowledged++;
                }
                else
                {
                    JsonElement settled = QueueNack(
                        topic, group, id, receipt, retryDelayMs,
                        "queue handler failed");
                    if (settled.TryGetProperty("deadLettered", out var dead) && dead.GetBoolean())
                        result.DeadLettered++;
                    else
                        result.Retried++;
                }
            }
            return result;
        }

        /// <summary>Return the .NET decorator-equivalent one-batch wrapper.</summary>
        public Func<QueueProcessResult> QueueConsumer(
            string topic,
            string group,
            Action<JsonElement> handler,
            int maxMessages = 1,
            int visibilityTimeoutMs = 30000,
            int maxAttempts = 3,
            int retryDelayMs = 0) =>
            () => QueueProcess(topic, group, handler, maxMessages,
                visibilityTimeoutMs, maxAttempts, retryDelayMs);

        /// <summary>Run a method configured with FyloQueueConsumerAttribute.</summary>
        public QueueProcessResult RunQueueConsumer(object target, string methodName)
        {
            if (target == null) throw new ArgumentNullException(nameof(target));
            MethodInfo method = target.GetType().GetMethod(
                methodName,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                ?? throw new FyloException($"queue consumer method not found: {methodName}");
            var consumer = method.GetCustomAttribute<FyloQueueConsumerAttribute>()
                ?? throw new FyloException("queue consumer method lacks FyloQueueConsumerAttribute");
            return QueueProcess(
                consumer.Topic,
                consumer.Group,
                delivery =>
                {
                    try
                    {
                        method.Invoke(target, new object[] { delivery });
                    }
                    catch (TargetInvocationException error) when (error.InnerException != null)
                    {
                        throw error.InnerException;
                    }
                },
                consumer.MaxMessages,
                consumer.VisibilityTimeoutMs,
                consumer.MaxAttempts,
                consumer.RetryDelayMs);
        }

        // --- Documents (object args are native objects: Dictionary, arrays) ---
        public JsonElement PutData(string collection, object data) =>
            Op($"{{\"op\":\"putData\",\"collection\":{J(collection)},\"data\":{J(data)}}}");
        public JsonElement GetDoc(string collection, string id) =>
            Op($"{{\"op\":\"getDoc\",\"collection\":{J(collection)},\"id\":{J(id)}}}");
        public JsonElement GetMeta(string collection, string id) =>
            Op($"{{\"op\":\"getMeta\",\"collection\":{J(collection)},\"id\":{J(id)}}}");
        public JsonElement SetMeta(string collection, string id, object meta) =>
            Op($"{{\"op\":\"setMeta\",\"collection\":{J(collection)},\"id\":{J(id)},\"meta\":{J(meta)}}}");
        public JsonElement GetLatest(string collection, string id) =>
            Op($"{{\"op\":\"getLatest\",\"collection\":{J(collection)},\"id\":{J(id)}}}");
        public JsonElement PatchDoc(string collection, string id, object newDoc) =>
            Op($"{{\"op\":\"patchDoc\",\"collection\":{J(collection)},\"id\":{J(id)},\"newDoc\":{J(newDoc)}}}");
        public JsonElement DelDoc(string collection, string id) =>
            Op($"{{\"op\":\"delDoc\",\"collection\":{J(collection)},\"id\":{J(id)}}}");
        public JsonElement RestoreDoc(string collection, string id) =>
            Op($"{{\"op\":\"restoreDoc\",\"collection\":{J(collection)},\"id\":{J(id)}}}");

        // --- Query ---
        public JsonElement FindDocs(string collection, object query) =>
            Op($"{{\"op\":\"findDocs\",\"collection\":{J(collection)},\"query\":{J(query)}}}");
        public JsonElement FindDocsPage(string collection, object query, object page) =>
            Op($"{{\"op\":\"findDocs\",\"collection\":{J(collection)},\"query\":{J(query)},\"page\":{J(page)}}}");
        public JsonElement FindDeletedDocsPage(string collection, object query, object page) =>
            Op($"{{\"op\":\"findDeletedDocs\",\"collection\":{J(collection)},\"query\":{J(query)},\"page\":{J(page)}}}");
        public JsonElement ExecuteSQL(string sql, object access = null) =>
            Op(access == null
                ? $"{{\"op\":\"executeSQL\",\"sql\":{J(sql)}}}"
                : $"{{\"op\":\"executeSQL\",\"sql\":{J(sql)},\"access\":{J(access)}}}");

        // Interpolated-string SQL — interpolated values are escaped, so
        //   db.Sql($"SELECT * FROM users WHERE name = {name}")
        // is injection-safe.
        public JsonElement Sql(FormattableString query, object access = null)
        {
            object[] args = query.GetArguments();
            var escaped = new object[args.Length];
            for (int i = 0; i < args.Length; i++) escaped[i] = SqlValue(args[i]);
            return ExecuteSQL(string.Format(query.Format, escaped), access);
        }

        private static string SqlValue(object value)
        {
            switch (value)
            {
                case null:
                    return "NULL";
                case bool b:
                    return b ? "true" : "false";
                case sbyte or byte or short or ushort or int or uint or long or ulong or float or double or decimal:
                    return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? "NULL";
                case DateTime dt:
                    return "'" + dt.ToString("o").Replace("'", "''") + "'";
                default:
                    return "'" + value.ToString().Replace("'", "''") + "'";
            }
        }

        /// <summary>
        /// Collection-scoped facade with short method names, so
        /// db.Collection("users").Put(data) reads like the browser client.
        /// </summary>
        public FyloCollection Collection(string name) => new FyloCollection(this, name);

        public void Dispose()
        {
            if (!_proc.HasExited)
            {
                _proc.StandardInput.Close(); // EOF ends the loop
                _proc.WaitForExit(30_000);
            }
            _proc.Dispose();
        }
    }

    /// <summary>A collection-scoped view; methods drop the leading collection argument.</summary>
    public sealed class FyloCollection
    {
        private readonly Fylo _db;
        private readonly string _name;

        public FyloCollection(Fylo db, string name)
        {
            _db = db;
            _name = name;
        }

        public JsonElement Create(string kind = "document") => _db.CreateCollection(_name, kind);
        public JsonElement Drop() => _db.DropCollection(_name);
        public JsonElement Inspect() => _db.InspectCollection(_name);
        public JsonElement Rebuild() => _db.RebuildCollection(_name);
        public JsonElement Put(object data) => _db.PutData(_name, data);
        public JsonElement Get(string id) => _db.GetDoc(_name, id);
        public JsonElement GetMeta(string id) => _db.GetMeta(_name, id);
        public JsonElement SetMeta(string id, object meta) => _db.SetMeta(_name, id, meta);
        public JsonElement Latest(string id) => _db.GetLatest(_name, id);
        public JsonElement Patch(string id, object newDoc) => _db.PatchDoc(_name, id, newDoc);
        public JsonElement Delete(string id) => _db.DelDoc(_name, id);
        public JsonElement Restore(string id) => _db.RestoreDoc(_name, id);
        public JsonElement Find(object query) => _db.FindDocs(_name, query);
        public JsonElement FindPage(object query, object page) => _db.FindDocsPage(_name, query, page);
    }
}
