/// A count and its Russian noun, shared by music collection summaries.
String musicQuantity(
  int count, {
  required String one,
  required String few,
  required String many,
}) {
  final hundred = count.abs() % 100;
  final digit = count.abs() % 10;
  final noun = hundred >= 11 && hundred <= 14
      ? many
      : digit == 1
      ? one
      : digit >= 2 && digit <= 4
      ? few
      : many;
  return '$count $noun';
}
