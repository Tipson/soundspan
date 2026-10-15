// Standalone synthetic chooser acceptance screen: no session, network or upload.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:soundspan/app/native_documents.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MaterialApp(home: _Preview()));
}

class _Preview extends StatefulWidget {
  const _Preview();
  @override
  State<_Preview> createState() => _PreviewState();
}

class _PreviewState extends State<_Preview> {
  final documents = NativeDocuments();
  String status = 'READY';
  bool busy = false;

  Future<void> pick(String kind) async {
    setState(() {
      busy = true;
      status = 'PICKING $kind';
    });
    try {
      if (kind == 'playlist') {
        final file = await documents.pickPlaylist(isCurrent: () => mounted);
        status = file == null
            ? 'CANCEL playlist'
            : 'PLAYLIST ${file.name}\nBASE64 ${base64Encode(utf8.encode(file.content))}';
      } else if (kind == 'image') {
        final file = await documents.pickAvatar(isCurrent: () => mounted);
        status = file == null
            ? 'CANCEL image'
            : 'IMAGE ${file.width}x${file.height} ${file.mimeType} ${file.bytes.length}';
      } else {
        final file = await const MethodChannel('soundspan/documents')
            .invokeMapMethod<String, Object?>('pick', {'kind': 'image'});
        status = file == null
            ? 'CANCEL raw'
            : 'RAW ${file['name']}\nBASE64 ${base64Encode(file['bytes'] as List<int>)}';
      }
    } catch (_) {
      status = 'SAFE ERROR';
    }
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Document picker acceptance')),
    body: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ElevatedButton(
            onPressed: busy ? null : () => pick('playlist'),
            child: const Text('Pick playlist'),
          ),
          ElevatedButton(
            onPressed: busy ? null : () => pick('image'),
            child: const Text('Pick image'),
          ),
          ElevatedButton(
            onPressed: busy ? null : () => pick('raw'),
            child: const Text('Verify image bytes'),
          ),
          const SizedBox(height: 24),
          Text(status),
        ],
      ),
    ),
  );
}
