import '../core/model/app_failure.dart';
import '../core/model/owner_key.dart';
import '../core/storage/owner_store.dart';
import 'automatic_download_control.dart';
import 'download_network_rules.dart';

/// Share durable rules between visible and headless consumers. The version-2
/// automation row also stops older workers from admitting unrestricted jobs.
/// Unknown rule records are preserved; their error is raised after that barrier
/// commits, rather than rolling the barrier back with a failed decode.
Future<DownloadNetworkRules> loadDownloadNetworkRules(
  OwnerStore store,
  SessionFence fence,
) async {
  final result = await store.transaction<Object>(fence, (tx) async {
    await _closeLegacyAutomation(tx);
    final row = await tx.read(
      DownloadNetworkRules.namespace,
      DownloadNetworkRules.key,
    );
    final DownloadNetworkRules rules;
    try {
      rules = DownloadNetworkRules.decode(row);
    } on AppFailure catch (failure) {
      return failure;
    }
    if (row == null) {
      await tx.write(
        DownloadNetworkRules.namespace,
        DownloadNetworkRules.key,
        rules.encode(),
      );
    }
    return rules;
  });
  if (result is AppFailure) throw result;
  return result as DownloadNetworkRules;
}

/// An explicit user choice updates the rules and legacy barrier atomically.
/// Network operations and worker cancellation stay outside this transaction.
Future<void> saveDownloadNetworkRules(
  OwnerStore store,
  SessionFence fence,
  DownloadNetworkRules rules,
) => store.transaction(fence, (tx) async {
  await _closeLegacyAutomation(tx);
  await tx.write(
    DownloadNetworkRules.namespace,
    DownloadNetworkRules.key,
    rules.encode(),
  );
});

Future<void> _closeLegacyAutomation(OwnerTransaction tx) async {
  final control = await tx.read(
    AutomaticDownloadControl.namespace,
    AutomaticDownloadControl.key,
  );
  if (control == null ||
      (control['version'] == 1 && control['paused'] is bool)) {
    await tx.write(
      AutomaticDownloadControl.namespace,
      AutomaticDownloadControl.key,
      AutomaticDownloadControl.encode(AutomaticDownloadControl.paused(control)),
    );
  }
}
