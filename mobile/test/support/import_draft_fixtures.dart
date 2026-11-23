Map<String, Object?> draftJobDto({
  String status = 'awaiting_confirmation',
  int revision = 1,
  String user = 'a',
}) => {
  'id': 'draft-1',
  'userId': user,
  'status': status,
  'progress': 100,
  'draftRevision': revision,
  'confirmedSnapshot': null,
  'draftResult': null,
  'draftData': {
    'version': 1,
    'normalized': {
      'version': 1,
      'format': 'text',
      'name': 'Мой импорт',
      'sourceHash': 'a' * 64,
      'groups': [
        {'id': 'p0', 'name': 'Мой импорт'},
      ],
      'entries': [
        {
          'id': 'e0',
          'category': 'playlists',
          'groupId': 'p0',
          'position': 0,
          'artist': 'Artist',
          'title': 'Song',
          'album': null,
          'sourceRef': null,
          'unresolvedReason': null,
        },
      ],
    },
    'preview': status == 'draft'
        ? null
        : {
            'revision': revision,
            'previewRevision': 2,
            'mappingDigest': 'b' * 64,
            'rows': [
              {
                'entryId': 'e0',
                'confidence': 85,
                'negativeId': null,
                'unresolvedReason': null,
                'match': {
                  'source': 'youtube',
                  'confidence': 85,
                  'videoId': 'recording',
                  'title': 'Song',
                  'artist': 'Artist',
                  'duration': 180,
                },
              },
            ],
          },
  },
};
