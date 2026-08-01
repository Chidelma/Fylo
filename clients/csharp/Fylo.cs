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
using System.Text;
using System.Text.Json;

namespace Fylo
{
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
