# just_audio Android

Pinned Android module from just_audio 0.10.6, with the upstream MIT licence and upstream-sha256.json.
Only AudioPlayer.java and MainMethodCallHandler.java differ from upstream: the read-only soundspanReadPlayback method returns ExoPlayer.isPlaying and its position for a matching audio session and exact current source URI.
It never starts, seeks, replaces or creates a player. The global hosted package cache and Dart/iOS implementation remain upstream. settings.gradle.kts requires review when the pinned upstream Java changes.
