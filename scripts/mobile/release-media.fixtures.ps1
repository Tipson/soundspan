# Hand-checked fixture for aapt dump --values resources. ZIP paths deliberately
# differ from logical resource names, as they do after Android resource shrinking.
function New-MediaResourceFixture {
    $names = @('audio_service_pause','audio_service_play_arrow','audio_service_skip_previous','audio_service_skip_next','audio_service_stop','ic_stat_soundspan')
    $lines = [Collections.Generic.List[string]]::new()
    $entries = [Collections.Generic.List[object]]::new()
    $lines.Add('Package Groups (1)')
    $lines.Add('Package Group 0 id=0x7f packageCount=1 name=ru.agentik007.soundspan')
    $lines.Add('  Package 0 id=0x7f name=ru.agentik007.soundspan')
    $lines.Add('    type 6 configCount=1 entryCount=6')
    for ($index = 0; $index -lt $names.Count; $index++) {
        $id = '0x7f07000' + ($index + 1)
        $lines.Add("      spec resource $id ru.agentik007.soundspan:drawable/$($names[$index]): flags=0x00000000")
    }
    $lines.Add('      config (default):')
    for ($index = 0; $index -lt $names.Count; $index++) {
        $id = '0x7f07000' + ($index + 1)
        $path = "res/media$index.xml"
        $lines.Add("        resource $id ru.agentik007.soundspan:drawable/$($names[$index]): t=0x03 d=0x0000000$index (s=0x0008 r=0x00)")
        $lines.Add("          (string8) `"$path`"")
        $entries.Add(@{path=$path;nonempty=$true})
    }
    return [pscustomobject]@{ resources=($lines -join "`n"); entries=$entries.ToArray(); names=$names }
}
