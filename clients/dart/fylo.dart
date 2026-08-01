// Fylo client — drives the `fylo` binary's persistent NDJSON loop.
//
// Dart SDK only (dart:io, dart:convert, dart:async). Requires the `fylo` binary
// on PATH (brew/scoop) or an explicit path. One long-lived subprocess keeps the
// engine warm across calls.
//
//   final db = await Fylo.open('/path/to/db');
//   await db.createCollection('users');
//   final id = await db.putData('users', {'name': 'Ada', 'role': 'admin'});
//   final doc = await db.getLatest('users', id);
//   final admins = await db.findDocs('users', {r'$ops': [{'role': {r'$eq': 'admin'}}]});
//   await db.close();
//
// Each operation method builds the request and resolves with the op's `result`
// (throwing on failure). Method names mirror the machine-protocol op names in
// Dart's lowerCamelCase. `request(op)` remains a raw escape hatch resolving the
// full response — use it for ops without a dedicated method (branching, schema…).
// Requests are queued: each resolves with its own response line, in order.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

class FyloException implements Exception {
  final String message;
  FyloException(this.message);
  @override
  String toString() => 'FyloException: $message';
}

class Fylo {
  static const int maxRequestBytes = 1024 * 1024;
  static const int maxResponseBytes = 8 * 1024 * 1024;
  final Process _proc;
  final IOSink _stdin;
  final List<Completer<Map<String, dynamic>>> _queue = [];
  final Uint8List _responseBuffer = Uint8List(maxResponseBytes);
  int _responseLength = 0;
  bool _responseOversized = false;

  Fylo._(this._proc, this._stdin, Stream<List<int>> bytes) {
    bytes.listen((chunk) {
      for (final byte in chunk) {
        if (byte != 0x0a) {
          if (!_responseOversized) {
            if (_responseLength >= maxResponseBytes) {
              _responseLength = 0;
              _responseOversized = true;
            } else {
              _responseBuffer[_responseLength++] = byte;
            }
          }
          continue;
        }
        if (_responseOversized) {
          _failAll(
              FyloException('FYLO response exceeds $maxResponseBytes bytes'));
          _proc.kill();
          return;
        }
        if (_queue.isNotEmpty) {
          final completer = _queue.removeAt(0);
          try {
            final line = utf8.decode(
                Uint8List.sublistView(_responseBuffer, 0, _responseLength),
                allowMalformed: false);
            completer.complete(jsonDecode(line) as Map<String, dynamic>);
          } catch (error) {
            completer.completeError(
                FyloException('fylo returned malformed UTF-8 or JSON'));
            _failAll(FyloException('fylo returned malformed UTF-8 or JSON'));
            _proc.kill();
            return;
          }
        }
        _responseLength = 0;
        _responseOversized = false;
      }
    }, onDone: () {
      _failAll(FyloException('fylo process exited'));
    });
  }

  void _failAll(FyloException error) {
    for (final completer in _queue) {
      if (!completer.isCompleted) completer.completeError(error);
    }
    _queue.clear();
  }

  /// Start a warm fylo process rooted at [root]. [binary] defaults to `fylo`.
  static Future<Fylo> open(String root, {String binary = 'fylo'}) async {
    final args = [
      'exec',
      '--loop',
      '--root',
      root,
      '--max-request-bytes',
      '$maxRequestBytes',
      '--max-response-bytes',
      '$maxResponseBytes'
    ];
    final proc = await Process.start(binary, args);
    return Fylo._(proc, proc.stdin, proc.stdout);
  }

  /// Send one raw machine-protocol op; resolves with the full response object.
  Future<Map<String, dynamic>> request(Map<String, dynamic> op) {
    final payload = utf8.encode(jsonEncode(op));
    if (payload.length > maxRequestBytes) {
      return Future.error(
          FyloException('FYLO request exceeds $maxRequestBytes bytes'));
    }
    final completer = Completer<Map<String, dynamic>>();
    _queue.add(completer);
    _stdin.add([...payload, 0x0a]);
    return completer.future;
  }

  Future<dynamic> _op(String name, Map<String, dynamic> fields) async {
    final payload = <String, dynamic>{'op': name};
    fields.forEach((key, value) {
      if (value != null) payload[key] = value;
    });
    final response = await request(payload);
    if (response['ok'] != true) {
      final error = response['error'];
      throw FyloException(
          (error is Map ? error['message'] : null) ?? 'fylo error');
    }
    return response['result'];
  }

  // --- Collections ---
  Future<dynamic> createCollection(String collection,
          [String kind = 'document']) =>
      _op('createCollection', {'collection': collection, 'kind': kind});
  Future<dynamic> dropCollection(String collection) =>
      _op('dropCollection', {'collection': collection});
  Future<dynamic> inspectCollection(String collection) =>
      _op('inspectCollection', {'collection': collection});
  Future<dynamic> rebuildCollection(String collection) =>
      _op('rebuildCollection', {'collection': collection});

  // --- Documents ---
  Future<dynamic> putData(String collection, Map<String, dynamic> data) =>
      _op('putData', {'collection': collection, 'data': data});
  Future<dynamic> batchPutData(String collection, List<dynamic> batch) =>
      _op('batchPutData', {'collection': collection, 'batch': batch});
  Future<dynamic> getDoc(String collection, String id) =>
      _op('getDoc', {'collection': collection, 'id': id});
  Future<dynamic> getMeta(String collection, String id) =>
      _op('getMeta', {'collection': collection, 'id': id});
  Future<dynamic> setMeta(
          String collection, String id, Map<String, dynamic> meta) =>
      _op('setMeta', {'collection': collection, 'id': id, 'meta': meta});
  Future<dynamic> getLatest(String collection, String id) =>
      _op('getLatest', {'collection': collection, 'id': id});
  Future<dynamic> patchDoc(
          String collection, String id, Map<String, dynamic> newDoc) =>
      _op('patchDoc', {'collection': collection, 'id': id, 'newDoc': newDoc});
  Future<dynamic> patchDocs(String collection, Map<String, dynamic> update) =>
      _op('patchDocs', {'collection': collection, 'update': update});
  Future<dynamic> delDoc(String collection, String id) =>
      _op('delDoc', {'collection': collection, 'id': id});
  Future<dynamic> delDocs(String collection, Map<String, dynamic> criteria) =>
      _op('delDocs', {'collection': collection, 'delete': criteria});
  Future<dynamic> restoreDoc(String collection, String id) =>
      _op('restoreDoc', {'collection': collection, 'id': id});

  // --- Query ---
  Future<dynamic> findDocs(String collection, Map<String, dynamic> query) =>
      _op('findDocs', {'collection': collection, 'query': query});
  Future<dynamic> findDeletedDocs(
          String collection, Map<String, dynamic> query) =>
      _op('findDeletedDocs', {'collection': collection, 'query': query});
  Future<dynamic> findDocsPage(String collection, Map<String, dynamic> query,
          Map<String, dynamic> page) =>
      _op('findDocs', {'collection': collection, 'query': query, 'page': page});
  Future<dynamic> findDeletedDocsPage(String collection,
          Map<String, dynamic> query, Map<String, dynamic> page) =>
      _op('findDeletedDocs',
          {'collection': collection, 'query': query, 'page': page});
  Future<dynamic> joinDocs(Map<String, dynamic> join) =>
      _op('joinDocs', {'join': join});
  Future<dynamic> executeSQL(String sql, {int? uid, int? gid, int? mode}) =>
      _op('executeSQL', {
        'sql': sql,
        'access': uid == null && gid == null && mode == null
            ? null
            : {
                if (uid != null) 'uid': uid,
                if (gid != null) 'gid': gid,
                if (mode != null) 'mode': mode
              }
      });

  /// Run raw SQL, built with native interpolation: db.sql("… ${x}").
  /// Values are inlined verbatim — escape/validate untrusted input yourself.
  Future<dynamic> sql(String query, {int? uid, int? gid, int? mode}) =>
      executeSQL(query, uid: uid, gid: gid, mode: mode);

  Future<dynamic> importBulkData(String collection, String url) =>
      _op('importBulkData', {'collection': collection, 'url': url});

  /// Collection-scoped facade with short method names, so
  /// `db.collection('users').put(data)` reads like the browser client.
  FyloCollection collection(String name) => FyloCollection(this, name);

  /// Close stdin so the loop ends, and wait for the process to exit.
  Future<void> close() async {
    await _stdin.close();
    await _proc.exitCode;
  }
}

/// A collection-scoped view; methods drop the leading collection argument.
class FyloCollection {
  final Fylo _db;
  final String _name;

  FyloCollection(this._db, this._name);

  Future<dynamic> create([String kind = 'document']) =>
      _db.createCollection(_name, kind);
  Future<dynamic> drop() => _db.dropCollection(_name);
  Future<dynamic> inspect() => _db.inspectCollection(_name);
  Future<dynamic> rebuild() => _db.rebuildCollection(_name);
  Future<dynamic> put(Map<String, dynamic> data) => _db.putData(_name, data);
  Future<dynamic> get(String id) => _db.getDoc(_name, id);
  Future<dynamic> getMeta(String id) => _db.getMeta(_name, id);
  Future<dynamic> setMeta(String id, Map<String, dynamic> meta) =>
      _db.setMeta(_name, id, meta);
  Future<dynamic> latest(String id) => _db.getLatest(_name, id);
  Future<dynamic> patch(String id, Map<String, dynamic> newDoc) =>
      _db.patchDoc(_name, id, newDoc);
  Future<dynamic> delete(String id) => _db.delDoc(_name, id);
  Future<dynamic> restore(String id) => _db.restoreDoc(_name, id);
  Future<dynamic> find(Map<String, dynamic> query) =>
      _db.findDocs(_name, query);
  Future<dynamic> findPage(
          Map<String, dynamic> query, Map<String, dynamic> page) =>
      _db.findDocsPage(_name, query, page);
}
