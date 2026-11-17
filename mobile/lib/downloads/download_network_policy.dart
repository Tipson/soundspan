import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/network/network_policy.dart';
import '../core/storage/owner_store.dart';

/// The same durable offline flag is read by foreground and headless downloads.
/// An absent preference means online; corrupt or unknown records fail closed.
Future<NetworkPolicy> loadDownloadNetworkPolicy(
  OwnerStore store,
  SessionFence fence,
) async {
  final value = await store.transaction(
    fence,
    (tx) => tx.read('settings', 'network'),
  );
  return decodeDownloadNetworkPolicy(value);
}

/// Decode inside an existing owner transaction when a combined admission
/// snapshot must include both offline and download-specific preferences.
NetworkPolicy decodeDownloadNetworkPolicy(Map<String, Object?>? value) {
  if (value == null) return const NetworkPolicy.online();
  if (value.length != 2 || value['version'] != 1 || value['offline'] is! bool) {
    throw const AppFailure(
      code: 'invalid_network_preference',
      message: 'Настройка сети недоступна',
    );
  }
  return value['offline'] == true
      ? const NetworkPolicy.offline()
      : const NetworkPolicy.online();
}
