/// Shared strict HTTP Retry-After parsing for JSON and protected media.
final class RetryAfterPolicy {
  static Duration? parse({
    required int statusCode,
    required List<String>? values,
    required DateTime now,
  }) {
    if (statusCode != 429 && statusCode != 503) return null;
    if (values == null || values.length != 1) return null;
    final value = values.single.trim();
    if (value.length > 128) return null;
    if (RegExp(r'^\d{1,12}$').hasMatch(value)) {
      // Bounded parsing avoids integer/Duration overflow on untrusted headers.
      return Duration(seconds: int.parse(value));
    }
    final utcNow = now.toUtc();
    final date = _httpDate(value, utcNow);
    if (date == null) return null;
    final delay = date.difference(utcNow);
    return delay.isNegative ? Duration.zero : delay;
  }

  static const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  static const _months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  static final _imfDate = RegExp(
    r'^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$',
  );
  static final _rfc850Date = RegExp(
    r'^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$',
  );
  static final _asctimeDate = RegExp(
    r'^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$',
  );

  /// RFC 9110 section5.6.7: all three HTTP dates, with strict calendar fields.
  /// Dart HttpDate.parse normalizes overflows and does not expand RFC850 years.
  static DateTime? _httpDate(String value, DateTime now) {
    var match = _imfDate.firstMatch(value);
    var shortYear = false;
    if (match == null) {
      match = _rfc850Date.firstMatch(value);
      shortYear = match != null;
    }
    // Common order: weekday, day, month, year, hour, minute, second.
    final List<String> parts;
    if (match != null) {
      parts = List.generate(7, (index) => match!.group(index + 1)!);
    } else {
      match = _asctimeDate.firstMatch(value);
      if (match == null) return null;
      parts = [
        match.group(1)!,
        match.group(3)!.trim(),
        match.group(2)!,
        match.group(7)!,
        match.group(4)!,
        match.group(5)!,
        match.group(6)!,
      ];
    }
    final day = int.parse(parts[1]);
    final month = _months.indexOf(parts[2]) + 1;
    var year = int.parse(parts[3]);
    final hour = int.parse(parts[4]);
    final minute = int.parse(parts[5]);
    final second = int.parse(parts[6]);
    if (day < 1 || hour > 23 || minute > 59 || second > 60) return null;
    if (shortYear) year += (now.year ~/ 100) * 100;
    DateTime calendar() => DateTime.utc(
      year,
      month,
      day,
      hour,
      minute,
      second == 60 ? 59 : second,
    );
    var date = calendar();
    if (shortYear &&
        date.isAfter(
          DateTime.utc(
            now.year + 50,
            now.month,
            now.day,
            now.hour,
            now.minute,
            now.second,
          ),
        )) {
      year -= 100;
      date = calendar();
    }
    if (date.year != year ||
        date.month != month ||
        date.day != day ||
        _weekdays[date.weekday - 1] != parts[0].substring(0, 3)) {
      return null;
    }
    return second == 60 ? date.add(const Duration(seconds: 1)) : date;
  }
}
