import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/storage/owner_store.dart';

void main() {
  test('records detach and recursively freeze caller JSON', () {
    final children = <Object?>[
      <String, Object?>{'position': 37},
    ];
    final source = <String, Object?>{'children': children, 'nullable': null};
    final record = OwnerRecord(key: ' opaque/Ключ ', value: source);
    children.clear();
    source.clear();
    expect(record.key, ' opaque/Ключ ');
    expect(record.value, {
      'children': [
        <String, Object?>{'position': 37},
      ],
      'nullable': null,
    });
    expect(() => record.value.clear(), throwsUnsupportedError);
    final saved = record.value['children'] as List<Object?>;
    expect(() => saved.clear(), throwsUnsupportedError);
    expect(() => (saved.single as Map).clear(), throwsUnsupportedError);
  });

  test('records reject non JSON, nonfinite, cyclic and too deep values', () {
    final cycle = <Object?>[];
    cycle.add(cycle);
    Object? deep;
    for (var i = 0; i < 35; i++) {
      deep = [deep];
    }
    for (final invalid in [
      double.nan,
      double.infinity,
      DateTime(2026),
      BigInt.one,
      {1: 'non-string key'},
      cycle,
      deep,
    ]) {
      expect(
        () => OwnerRecord(key: 'key', value: {'value': invalid}),
        throwsArgumentError,
      );
    }
  });

  test('record bounds use UTF8 bytes and permit a large queue snapshot', () {
    expect(() => OwnerRecord(key: '', value: const {}), throwsArgumentError);
    expect(
      () => OwnerRecord(key: 'я' * 300, value: const {}),
      throwsArgumentError,
    );
    final largeQueue = List.generate(
      1000,
      (i) => {
        'entryId': 'entry-$i',
        'title': 'A track title ' * 30,
        'position': 37,
      },
    );
    expect(
      OwnerRecord(key: 'queue', value: {'entries': largeQueue}).value,
      contains('entries'),
    );
    expect(
      () => OwnerRecord(key: 'key', value: {'data': 'я' * (5 * 1024 * 1024)}),
      throwsArgumentError,
    );
  });
}
