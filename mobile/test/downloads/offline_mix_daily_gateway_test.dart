import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/downloads/offline_mix_daily_factory.dart';

final class ReplyClient implements JsonHttpClient {
  ReplyClient(this.reply);
  final ApiResponse reply;
  int calls = 0;
  @override
  Future<ApiResponse> send(ApiRequest request, {String? accessToken}) async {
    calls++;
    return reply;
  }
}

ApiRequest request(ApiMethod method) => ApiRequest(
  origin: Uri.parse('https://fixture.invalid'),
  method: method,
  path: '/api/personalized/daily-mixes',
);

void main() {
  for (final status in [502, 504]) {
    test(
      'safe mix GET $status becomes a scheduled retry without replaying HTTP',
      () async {
        final raw = ReplyClient(ApiResponse(status, null));
        var admissions = 0;
        final client = OfflineMixRefreshJsonClient(raw, () async {
          admissions++;
        });
        await expectLater(
          client.send(request(ApiMethod.get)),
          throwsA(
            isA<AppFailure>()
                .having((e) => e.code, 'code', 'http_error')
                .having((e) => e.statusCode, 'status', status)
                .having((e) => e.retryable, 'scheduled retry allowed', true),
          ),
        );
        expect(raw.calls, 1);
        expect(admissions, 1);
      },
    );
  }
  for (final method in [
    ApiMethod.post,
    ApiMethod.put,
    ApiMethod.patch,
    ApiMethod.delete,
  ]) {
    test(
      'ambiguous ${method.name} gateway failure keeps its original policy',
      () async {
        final reply = const ApiResponse(504, null);
        final raw = ReplyClient(reply);
        final client = OfflineMixRefreshJsonClient(raw, () async {});
        expect(await client.send(request(method)), same(reply));
        expect(
          reply.requireSuccess,
          throwsA(
            isA<AppFailure>().having(
              (e) => e.retryable,
              'no mutation replay',
              false,
            ),
          ),
        );
        expect(raw.calls, 1);
      },
    );
  }
  test('admission rejection prevents even a safe GET dispatch', () async {
    final raw = ReplyClient(const ApiResponse(200, {'mixes': []}));
    final client = OfflineMixRefreshJsonClient(raw, () async {
      throw StateError('retired fixture');
    });
    await expectLater(client.send(request(ApiMethod.get)), throwsStateError);
    expect(raw.calls, 0);
  });
}
