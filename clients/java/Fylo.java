// Fylo client — drives the `fylo` binary's persistent NDJSON loop.
//
// No dependencies (java.lang.Process only). Requires the `fylo` binary on PATH
// (brew/scoop) or an explicit path. One long-lived subprocess keeps the engine
// warm across calls.
//
//   try (Fylo db = new Fylo("/path/to/db")) {
//       db.createCollection("users");
//       String put = db.putData("users", Map.of("name", "Ada", "role", "admin"));
//       String admins = db.findDocs("users",
//           Map.of("$ops", List.of(Map.of("role", Map.of("$eq", "admin")))));
//   }
//
// Each operation method builds the request, checks it succeeded, and returns the
// raw JSON response line (parse `result` with Jackson/Gson). Method names follow
// Java's camelCase convention; object arguments are native Maps/Lists, encoded
// to JSON by the built-in `toJson`. request(json) is the raw escape hatch.

import java.io.BufferedInputStream;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class Fylo implements AutoCloseable {
    private static final int MAX_REQUEST_BYTES = 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    private final Process proc;
    private final BufferedWriter in;
    private final InputStream out;
    private final byte[] responseBuffer = new byte[MAX_RESPONSE_BYTES + 1];

    public Fylo(String root) throws IOException {
        this(root, "fylo");
    }

    public Fylo(String root, String binary) throws IOException {
        List<String> args = new ArrayList<>(List.of(binary, "exec", "--loop", "--root", root));
        args.add("--max-request-bytes");
        args.add(Integer.toString(MAX_REQUEST_BYTES));
        args.add("--max-response-bytes");
        args.add(Integer.toString(MAX_RESPONSE_BYTES));
        this.proc = new ProcessBuilder(args)
                .redirectError(ProcessBuilder.Redirect.INHERIT)
                .start();
        this.in = new BufferedWriter(
                new OutputStreamWriter(proc.getOutputStream(), StandardCharsets.UTF_8));
        this.out = new BufferedInputStream(proc.getInputStream());
    }

    /** Send one raw machine-protocol op (JSON string); returns the response line. */
    public synchronized String request(String opJson) throws IOException {
        if (!proc.isAlive()) throw new IOException("fylo process has exited");
        String payload = opJson.stripTrailing();
        if (payload.getBytes(StandardCharsets.UTF_8).length > MAX_REQUEST_BYTES) {
            throw new IOException("FYLO request exceeds " + MAX_REQUEST_BYTES + " bytes");
        }
        in.write(payload);
        in.write('\n');
        in.flush();
        int length = 0;
        while (length <= MAX_RESPONSE_BYTES) {
            int next = out.read();
            if (next < 0) throw new IOException("fylo closed the stream");
            if (next == '\n') {
                try {
                    return StandardCharsets.UTF_8.newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(responseBuffer, 0, length))
                            .toString();
                } catch (java.nio.charset.CharacterCodingException error) {
                    proc.destroyForcibly();
                    throw new IOException("fylo returned malformed UTF-8", error);
                }
            }
            responseBuffer[length++] = (byte) next;
        }
        proc.destroyForcibly();
        throw new IOException("FYLO response exceeds " + MAX_RESPONSE_BYTES + " bytes");
    }

    // Build an op from native fields, send it, and error on a failure response.
    // ponytail: checks for the always-present "ok":true field by substring.
    private String op(String name, Object... kv) throws IOException {
        StringBuilder sb = new StringBuilder("{\"op\":").append(toJson(name));
        for (int i = 0; i + 1 < kv.length; i += 2) {
            sb.append(',').append(toJson(kv[i].toString())).append(':').append(toJson(kv[i + 1]));
        }
        String resp = request(sb.append('}').toString());
        if (!resp.contains("\"ok\":true")) throw new IOException(resp.strip());
        return resp;
    }

    // Quote a string as a JSON string literal, escaping control characters so an
    // embedded newline/tab can't break the newline-delimited protocol.
    static String quote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    // Minimal JSON encoder for String / Number / Boolean / Map / Iterable / null.
    static String toJson(Object v) {
        if (v == null) return "null";
        if (v instanceof String) {
            return quote((String) v);
        }
        if (v instanceof Boolean || v instanceof Number) return v.toString();
        if (v instanceof Map) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(toJson(e.getKey().toString())).append(':').append(toJson(e.getValue()));
            }
            return sb.append('}').toString();
        }
        if (v instanceof Iterable) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object x : (Iterable<?>) v) {
                if (!first) sb.append(',');
                first = false;
                sb.append(toJson(x));
            }
            return sb.append(']').toString();
        }
        throw new IllegalArgumentException("unsupported JSON value: " + v.getClass());
    }

    // --- Collections ---
    public String createCollection(String collection) throws IOException {
        return createCollection(collection, "document");
    }
    public String createCollection(String collection, String kind) throws IOException {
        return op("createCollection", "collection", collection, "kind", kind);
    }
    public String dropCollection(String collection) throws IOException {
        return op("dropCollection", "collection", collection);
    }
    public String inspectCollection(String collection) throws IOException {
        return op("inspectCollection", "collection", collection);
    }
    public String rebuildCollection(String collection) throws IOException {
        return op("rebuildCollection", "collection", collection);
    }

    // --- Documents (object args are native Maps/Lists) ---
    public String putData(String collection, Map<String, Object> data) throws IOException {
        return op("putData", "collection", collection, "data", data);
    }
    public String getDoc(String collection, String id) throws IOException {
        return op("getDoc", "collection", collection, "id", id);
    }
    public String getMeta(String collection, String id) throws IOException {
        return op("getMeta", "collection", collection, "id", id);
    }
    public String setMeta(String collection, String id, Map<String, Object> meta) throws IOException {
        return op("setMeta", "collection", collection, "id", id, "meta", meta);
    }
    public String getLatest(String collection, String id) throws IOException {
        return op("getLatest", "collection", collection, "id", id);
    }
    public String patchDoc(String collection, String id, Map<String, Object> newDoc)
            throws IOException {
        return op("patchDoc", "collection", collection, "id", id, "newDoc", newDoc);
    }
    public String delDoc(String collection, String id) throws IOException {
        return op("delDoc", "collection", collection, "id", id);
    }
    public String restoreDoc(String collection, String id) throws IOException {
        return op("restoreDoc", "collection", collection, "id", id);
    }

    // --- Query ---
    public String findDocs(String collection, Map<String, Object> query) throws IOException {
        return op("findDocs", "collection", collection, "query", query);
    }
    public String findDocsPage(String collection, Map<String, Object> query, Map<String, Object> page) throws IOException {
        return op("findDocs", "collection", collection, "query", query, "page", page);
    }
    public String findDeletedDocsPage(String collection, Map<String, Object> query, Map<String, Object> page) throws IOException {
        return op("findDeletedDocs", "collection", collection, "query", query, "page", page);
    }
    public String executeSQL(String sql) throws IOException {
        return op("executeSQL", "sql", sql);
    }
    public String executeSQL(String sql, Map<String, Object> access) throws IOException {
        return op("executeSQL", "sql", sql, "access", access);
    }

    // Run raw SQL, built with concatenation/String.format. Values are inlined
    // verbatim — escape/validate untrusted input yourself.
    public String sql(String query) throws IOException {
        return executeSQL(query);
    }
    public String sql(String query, Map<String, Object> access) throws IOException {
        return executeSQL(query, access);
    }

    /** Collection-scoped facade: db.collection("users").put(data). */
    public Collection collection(String name) {
        return new Collection(name);
    }

    /** A collection-scoped view; methods drop the leading collection argument. */
    public final class Collection {
        private final String name;

        private Collection(String name) {
            this.name = name;
        }

        public String create() throws IOException {
            return createCollection(name);
        }
        public String create(String kind) throws IOException {
            return createCollection(name, kind);
        }
        public String drop() throws IOException {
            return dropCollection(name);
        }
        public String inspect() throws IOException {
            return inspectCollection(name);
        }
        public String rebuild() throws IOException {
            return rebuildCollection(name);
        }
        public String put(Map<String, Object> data) throws IOException {
            return putData(name, data);
        }
        public String get(String id) throws IOException {
            return getDoc(name, id);
        }
        public String getMeta(String id) throws IOException { return Fylo.this.getMeta(name, id); }
        public String setMeta(String id, Map<String, Object> meta) throws IOException {
            return Fylo.this.setMeta(name, id, meta);
        }
        public String latest(String id) throws IOException {
            return getLatest(name, id);
        }
        public String patch(String id, Map<String, Object> newDoc) throws IOException {
            return patchDoc(name, id, newDoc);
        }
        public String delete(String id) throws IOException {
            return delDoc(name, id);
        }
        public String restore(String id) throws IOException {
            return restoreDoc(name, id);
        }
        public String find(Map<String, Object> query) throws IOException {
            return findDocs(name, query);
        }
        public String findPage(Map<String, Object> query, Map<String, Object> page) throws IOException {
            return findDocsPage(name, query, page);
        }
    }

    @Override
    public void close() throws IOException {
        if (proc.isAlive()) {
            in.close(); // EOF ends the loop
            try {
                proc.waitFor();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }
}
