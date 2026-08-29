# Settings Feature Domain

Start-here guide for `frontend/features/settings`.

## Start Here

1. Route entrypoints: `frontend/app/device/page.tsx`, `frontend/app/settings/page.tsx`
2. Primary tests and route entrypoints for this domain are listed below.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/settingsDisplayNameCompat.test.ts src/routes/__tests__/systemSettingsRuntime.test.ts src/routes/__tests__/deviceLinkRuntime.test.ts`
- `npm --prefix frontend run lint`
- `npm --prefix frontend run test:component`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/sections/AccountSection.tsx` | components |
| `components/sections/AppPasswordsPanel.tsx` | components |
| `components/sections/AIServicesSection.tsx` | components |
| `components/sections/APIKeysSection.tsx` | components |
| `components/sections/AudiobookshelfSection.tsx` | components |
| `components/sections/CacheSection.tsx` | components |
| `components/sections/DownloadPreferencesSection.tsx` | components |
| `components/sections/DeviceOfflineSettingsSection.tsx` | per-device offline automation controls |
| `components/sections/downloadSourceConfig.ts` | components |
| `components/sections/DownloadServicesSection.tsx` | components |
| `components/sections/FederationSection.tsx` | components |
| `components/sections/federationPairing.tsx` | components |
| `components/sections/federationPeerSettings.tsx` | components |
| `components/sections/FederationHealthPanel.tsx` | components |
| `components/sections/IntegrationsSection.tsx` | components |
| `components/sections/LibraryHealthSection.tsx` | components |
| `components/sections/libraryHealthDetails.tsx` | components |
| `components/sections/LibrarySafetySection.tsx` | minimal admin control for permanent local-album deletion |
| `components/sections/LidarrSection.tsx` | components |
| `components/sections/LinkedIdentitiesPanel.tsx` | components |
| `components/sections/playbackHistoryConfig.ts` | components |
| `components/sections/PlaybackHistorySection.tsx` | components |
| `components/sections/PlaybackSourcesSection.tsx` | components |
| `components/sections/PlaybackSection.tsx` | components |
| `components/sections/ScrobblingSection.tsx` | components |
| `components/sections/SocialSection.tsx` | components |
| `components/sections/SignInSecuritySection.tsx` | components |
| `components/sections/SoulseekSection.tsx` | components |
| `components/sections/StoragePathsSection.tsx` | components |
| `components/sections/TidalSection.tsx` | components |
| `components/sections/TidalStreamingSection.tsx` | components |
| `components/sections/UserManagementSection.tsx` | components |
| `components/sections/usePurgeProgress.ts` | components |
| `components/sections/YouTubeMusicSection.tsx` | components |
| `components/ui/ConnectionCard.tsx` | components |
| `components/ui/DeviceAuthLinkPanel.tsx` | components |
| `components/ui/index.ts` | components |
| `components/ui/InfoTooltip.tsx` | components |
| `components/ui/IntegrationCard.tsx` | components |
| `components/ui/ProfilePictureUpload.tsx` | components |
| `components/ui/SettingsInput.tsx` | components |
| `components/ui/SettingsLayout.tsx` | components |
| `components/ui/SettingsRow.tsx` | components |
| `components/ui/SettingsSection.tsx` | components |
| `components/ui/SettingsSelect.tsx` | components |
| `components/ui/SettingsSidebar.tsx` | components |
| `components/ui/SettingsToggle.tsx` | components |
| `components/ui/settingsFieldStyles.ts` | shared settings-field styles |
| `hooks/settingsHydration.ts` | hooks |
| `hooks/useAPIKeys.ts` | hooks |
| `hooks/useConnectionTest.ts` | hooks |
| `hooks/useSettingsData.ts` | hooks |
| `hooks/useSystemSettings.ts` | hooks |
| `hooks/useTwoFactor.ts` | hooks |
| `lastFmScrobblingCopy.ts` | root |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README and keep the targeted commands below accurate in the same change set.

## Integration Surfaces

- Playback Sources and YouTube Music configure worldwide search, provider
  recommendations, and streaming. Source order is a priority list; disabled or
  unavailable providers are skipped. Public YouTube Music access can operate
  without linking a Google account, while optional linking adds personal
  library access.
- Playlist import copies playlist structure and matched provider references; it
  does not fetch audio from Spotify or implicitly save files to the server.
- This personal streaming deployment exposes active playback sources, YouTube
  Music, artwork/cache controls, permanent local-album deletion safety, and user
  administration on the Admin page. The destructive policy is off by default;
  upstream server-download and broader local-library maintenance components
  stay in the source tree for compatibility but are intentionally not mounted.
- Per-device offline copies and automatic liked-song downloads belong to the
  ordinary user Settings page; they never invoke server acquisition services
  or synchronize queue, ready, or delete state to another device. If browser
  storage cannot be read, these controls stay explicitly unavailable beside a
  Retry action rather than silently falling back to default values.
