#!/usr/bin/env bash

set -uo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8080}"
SRT_HOST="${SRT_HOST:-127.0.0.1}"
if [[ "$SRT_HOST" == *:* && "$SRT_HOST" != \[*\] ]]; then
  SRT_HOST="[$SRT_HOST]"
fi
SRT_PORT="${SRT_PORT:-11997}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-35}"
RESOURCE_SAMPLES="${RESOURCE_SAMPLES:-3}"
WHEP_SAMPLE_MS="${WHEP_SAMPLE_MS:-5000}"
CASE_FILTER="${CASE_FILTER:-}"
RESULTS_FILE="${RESULTS_FILE:-/tmp/srt-performance-results.jsonl}"
FOUR_K_SOURCE_FILE="${FOUR_K_SOURCE_FILE:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for executable in curl jq ffmpeg node docker; do
  if ! command -v "$executable" >/dev/null; then
    printf 'missing required executable: %s\n' "$executable" >&2
    exit 2
  fi
done

if ! curl --fail --silent --show-error "$GATEWAY_URL/healthz" >/dev/null; then
  printf 'gateway is not healthy at %s\n' "$GATEWAY_URL" >&2
  exit 2
fi

work_dir="$(mktemp -d)"
channel_id=""
channel_path=""
sender_pid=""
passes=0
failures=0

stop_sender() {
  if [[ -z "$sender_pid" ]]; then
    return
  fi
  if kill -0 "$sender_pid" 2>/dev/null; then
    kill "$sender_pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      if ! kill -0 "$sender_pid" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    kill -KILL "$sender_pid" 2>/dev/null || true
  fi
  wait "$sender_pid" 2>/dev/null || true
  sender_pid=""
}

cleanup() {
  stop_sender
  if [[ -n "$channel_id" ]]; then
    curl --silent --output /dev/null --request DELETE "$GATEWAY_URL/api/v1/channels/$channel_id" || true
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

create_response="$(jq -n --argjson port "$SRT_PORT" '{
  name:"SRT performance temporary",
  enabled:true,
  input:{mode:"srt-push",srt:{port:$port}},
  maxReaders:0,
  useAbsoluteTimestamp:true
}' | curl --fail --silent --show-error \
  --header 'Content-Type: application/json' --data-binary @- \
  "$GATEWAY_URL/api/v1/channels")" || exit 2
channel_id="$(jq -r '.id' <<<"$create_response")"
channel_path="$(jq -r '.path' <<<"$create_response")"

gateway_container="$(docker compose ps -q gateway)"
mediamtx_container="$(docker compose ps -q mediamtx)"
if [[ -z "$gateway_container" || -z "$mediamtx_container" ]]; then
  printf 'gateway and MediaMTX containers must be running\n' >&2
  exit 2
fi
gateway_name="$(docker inspect --format '{{.Name}}' "$gateway_container")"
mediamtx_name="$(docker inspect --format '{{.Name}}' "$mediamtx_container")"
gateway_name="${gateway_name#/}"
mediamtx_name="${mediamtx_name#/}"

: >"$RESULTS_FILE"

channel_status() {
  curl --fail --silent --show-error "$GATEWAY_URL/api/v1/status" |
    jq -c --arg id "$channel_id" '.channels[] | select(.id == $id)'
}

wait_offline() {
  local state
  for _ in $(seq 1 120); do
    state="$(channel_status 2>/dev/null || true)"
    if [[ -n "$state" ]] && jq -e \
      '(.available | not) and (.outputReady | not) and (.compatibility.worker.running | not)' \
      <<<"$state" >/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

wait_ready() {
  local expected_mode="$1"
  local state
  local attempts=$((READY_TIMEOUT_SECONDS * 4))
  for _ in $(seq 1 "$attempts"); do
    state="$(channel_status 2>/dev/null || true)"
    if [[ -n "$state" ]] && jq -e --arg mode "$expected_mode" \
      '.outputReady and .compatibility.state == "ready" and .compatibility.mode == $mode' \
      <<<"$state" >/dev/null; then
      printf '%s' "$state"
      return 0
    fi
    if [[ -n "$sender_pid" ]] && ! kill -0 "$sender_pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  return 1
}

start_sender() {
  local case_name="$1"
  local transport="$2"
  local width="$3"
  local height="$4"
  local fps="$5"
  local video_format="$6"
  local video_bitrate="$7"
  local audio_format="$8"
  local audio_bitrate="$9"
  local target
  local -a inputs=()
  local -a mappings=()
  local -a codecs=()
  local input_index=0

	if [[ "$transport" == streamid ]]; then
		target="srt://$SRT_HOST:8890?pkt_size=1316&streamid=publish:$channel_path"
	else
		target="srt://$SRT_HOST:$SRT_PORT?pkt_size=1316"
	fi

  if [[ "$case_name" == full-h265-2160p30-* && -n "$FOUR_K_SOURCE_FILE" ]]; then
    ffmpeg -hide_banner -loglevel error -nostdin -re -stream_loop -1 -i "$FOUR_K_SOURCE_FILE" \
      -map 0:v:0 -map 0:a:0 -c copy -f mpegts "$target" >"$work_dir/$case_name.log" 2>&1 &
    sender_pid=$!
    return
  fi

  if [[ "$video_format" != none ]]; then
    inputs+=(-re -f lavfi -i "testsrc2=size=${width}x${height}:rate=$fps")
    mappings+=(-map "${input_index}:v:0")
    input_index=$((input_index + 1))
    case "$video_format" in
      h264-baseline)
        codecs+=(-c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -bf 0 -g "$fps" -b:v "$video_bitrate")
        ;;
      h264-high)
        codecs+=(-c:v libx264 -preset veryfast -tune zerolatency -profile:v high -pix_fmt yuv420p -bf 0 -g "$fps" -b:v "$video_bitrate")
        ;;
      h264-bframes)
        codecs+=(-c:v libx264 -preset veryfast -profile:v main -pix_fmt yuv420p -bf 3 -g "$fps" -b:v "$video_bitrate")
        ;;
      h265)
        codecs+=(-c:v libx265 -preset ultrafast -x265-params "pools=4:frame-threads=4:keyint=$fps:bframes=0:log-level=error" -b:v "$video_bitrate")
        ;;
      mpeg2)
        codecs+=(-c:v mpeg2video -g "$fps" -b:v "$video_bitrate")
        ;;
      mpeg4)
        codecs+=(-c:v mpeg4 -g "$fps" -bf 0 -b:v "$video_bitrate")
        ;;
    esac
  else
    codecs+=(-vn)
  fi

  if [[ "$audio_format" != none ]]; then
    inputs+=(-re -f lavfi -i sine=frequency=1000:sample_rate=48000)
    mappings+=(-map "${input_index}:a:0")
    case "$audio_format" in
      opus)
        codecs+=(-c:a libopus -application lowdelay -b:a "$audio_bitrate")
        ;;
      aac)
        codecs+=(-c:a aac -b:a "$audio_bitrate" -ac 2)
        ;;
      ac3)
        codecs+=(-c:a ac3 -b:a "$audio_bitrate" -ac 2)
        ;;
      mp2)
        codecs+=(-c:a mp2 -b:a "$audio_bitrate" -ac 2)
        ;;
      mp3)
        codecs+=(-c:a libmp3lame -b:a "$audio_bitrate" -ac 2)
        ;;
    esac
  else
    codecs+=(-an)
  fi

  ffmpeg -hide_banner -loglevel error -nostdin \
    "${inputs[@]}" "${mappings[@]}" "${codecs[@]}" -f mpegts "$target" \
    >"$work_dir/$case_name.log" 2>&1 &
  sender_pid=$!
}

sample_resources() {
  local stats_file="$work_dir/stats.jsonl"
  : >"$stats_file"
  for _ in $(seq 1 "$RESOURCE_SAMPLES"); do
    docker stats --no-stream --format '{{json .}}' "$gateway_container" "$mediamtx_container" >>"$stats_file"
  done
  jq -sc --arg gateway "$gateway_name" --arg mediamtx "$mediamtx_name" '
    def memory_mib:
      (.MemUsage | split(" / ")[0] | capture("(?<value>[0-9.]+)(?<unit>[A-Za-z]+)")) as $memory |
      ($memory.value | tonumber) *
        (if $memory.unit == "GiB" then 1024
         elif $memory.unit == "KiB" then (1 / 1024)
         elif $memory.unit == "B" then (1 / 1048576)
         else 1 end);
    def median: sort | .[(length / 2 | floor)];
    def summary($name):
      [.[] | select(.Name == $name) | {
        cpu: (.CPUPerc | rtrimstr("%") | tonumber),
        memoryMiB: memory_mib,
        pids: (.PIDs | tonumber)
      }] as $samples |
      {
        cpuMedian: ($samples | map(.cpu) | median),
        cpuAverage: ($samples | map(.cpu) | add / length),
        cpuMax: ($samples | map(.cpu) | max),
        memoryMiBMedian: ($samples | map(.memoryMiB) | median),
        memoryMiBMax: ($samples | map(.memoryMiB) | max),
        pidsMax: ($samples | map(.pids) | max)
      };
    {gateway: summary($gateway), mediamtx: summary($mediamtx)}
  ' "$stats_file"
}

record_failure() {
  local case_name="$1"
  local message="$2"
  failures=$((failures + 1))
  printf '%-40s FAIL  %s\n' "$case_name" "$message" >&2
  if [[ -s "$work_dir/$case_name.log" ]]; then
    while IFS= read -r line; do
      printf '  %s\n' "$line" >&2
    done <"$work_dir/$case_name.log"
  fi
  jq -cn --arg case "$case_name" --arg error "$message" \
    '{case:$case,passed:false,error:$error}' >>"$RESULTS_FILE"
}

run_case() {
  local case_name="$1"
  local transport="$2"
  local width="$3"
  local height="$4"
  local fps="$5"
  local video_format="$6"
  local video_bitrate="$7"
  local audio_format="$8"
  local audio_bitrate="$9"
  local expected_mode="${10}"
  local started_ns
  local ready_ns
  local measure_started_ns
  local measure_finished_ns
  local state
  local final_state
  local resources
  local whep
  local before_bytes
  local after_bytes
  local result
  local sender_cpu

  if [[ -n "$CASE_FILTER" && "$case_name" != *"$CASE_FILTER"* ]]; then
    return
  fi
  if ! wait_offline; then
    record_failure "$case_name" "previous source did not clean up"
    return
  fi

  started_ns="$(date +%s%N)"
  start_sender "$case_name" "$transport" "$width" "$height" "$fps" \
    "$video_format" "$video_bitrate" "$audio_format" "$audio_bitrate"
  if ! state="$(wait_ready "$expected_mode")"; then
    state="$(channel_status 2>/dev/null || true)"
    record_failure "$case_name" "not ready: $(jq -c '{available,tracks,outputReady,compatibility}' <<<"${state:-null}")"
    stop_sender
    wait_offline || true
    return
  fi
  ready_ns="$(date +%s%N)"
  sleep 2

  state="$(channel_status)"
  before_bytes="$(jq -r '.inboundBytes' <<<"$state")"
  measure_started_ns="$(date +%s%N)"
  resources="$(sample_resources)"
  if ! whep="$(WHEP_SAMPLE_MS="$WHEP_SAMPLE_MS" node "$SCRIPT_DIR/whep-probe.mjs" \
    "$GATEWAY_URL/api/v1/channels/$channel_id/whep" 2>&1)"; then
    record_failure "$case_name" "WHEP probe failed: $whep"
    stop_sender
    wait_offline || true
    return
  fi
  measure_finished_ns="$(date +%s%N)"
  final_state="$(channel_status)"
  after_bytes="$(jq -r '.inboundBytes' <<<"$final_state")"
  sender_cpu="$(ps -p "$sender_pid" -o %cpu= 2>/dev/null | tr -d ' ' || true)"

  result="$(jq -cn \
    --arg case "$case_name" \
    --arg transport "$transport" \
    --arg videoFormat "$video_format" \
    --arg videoBitrate "$video_bitrate" \
    --arg audioFormat "$audio_format" \
    --arg audioBitrate "$audio_bitrate" \
    --arg mode "$expected_mode" \
    --arg senderCPU "${sender_cpu:-0}" \
    --argjson width "$width" \
    --argjson height "$height" \
    --argjson fps "$fps" \
    --argjson startupNS "$((ready_ns - started_ns))" \
    --argjson measureNS "$((measure_finished_ns - measure_started_ns))" \
    --argjson beforeBytes "$before_bytes" \
    --argjson afterBytes "$after_bytes" \
    --argjson sampleMS "$WHEP_SAMPLE_MS" \
    --argjson resources "$resources" \
    --argjson whep "$whep" \
    --argjson status "$final_state" '
      ($whep.inbound | map(select(.kind == "video")) | first // {}) as $video |
      {
        case:$case,
        passed:true,
        transport:$transport,
        source:{
          width:$width,
          height:$height,
          fps:$fps,
          videoFormat:$videoFormat,
          videoBitrate:$videoBitrate,
          audioFormat:$audioFormat,
          audioBitrate:$audioBitrate,
          generatorCPU:($senderCPU | tonumber)
        },
        mode:$mode,
        startupMS:($startupNS / 1000000 | round),
        measuredIngressMbps:(if $measureNS > 0 then (($afterBytes - $beforeBytes) * 8000 / $measureNS) else 0 end),
        whepMbps:(($whep.sampleBytesReceived // $whep.bytesReceived) * 8 / $sampleMS / 1000),
        decodedFPS:(if ($video.sampleFramesDecoded // $video.framesDecoded // 0) > 0 then (($video.sampleFramesDecoded // $video.framesDecoded) * 1000 / $sampleMS) else 0 end),
        whepConnectionMS:$whep.connectionMS,
        firstPacketMS:$whep.firstPacketMS,
        firstFrameMS:$whep.firstFrameMS,
        framesDropped:($video.framesDropped // 0),
        resources:$resources,
        inputCodecs:[$status.tracks[].codec],
        outputCodecs:[$status.outputTracks[].codec],
        inboundFramesInError:$status.inboundFramesInError,
        workerRestarts:$status.compatibility.worker.restarts,
        whep:$whep
      }
    ')"
  printf '%s\n' "$result" >>"$RESULTS_FILE"
  passes=$((passes + 1))
  printf '%-40s PASS  %5d ms  GW %6.1f%%/%6.1f MiB  MTX %5.1f%%  in %5.1f Mb/s  WHEP %5.1f Mb/s %5.1f fps\n' \
    "$case_name" \
    "$(jq -r '.startupMS' <<<"$result")" \
    "$(jq -r '.resources.gateway.cpuMedian' <<<"$result")" \
    "$(jq -r '.resources.gateway.memoryMiBMedian' <<<"$result")" \
    "$(jq -r '.resources.mediamtx.cpuMedian' <<<"$result")" \
    "$(jq -r '.measuredIngressMbps' <<<"$result")" \
    "$(jq -r '.whepMbps' <<<"$result")" \
    "$(jq -r '.decodedFPS' <<<"$result")"

  stop_sender
  if ! wait_offline; then
    record_failure "$case_name-cleanup" "source or worker remained online"
  fi
}

printf 'Temporary channel: %s (%s), SRT port %s\n' "$channel_path" "$channel_id" "$SRT_PORT"
printf 'Resource baseline: %s\n' "$(sample_resources)"
printf 'Results: %s\n\n' "$RESULTS_FILE"

run_case direct-relay-360p30-800k-opus64k push 640 360 30 h264-baseline 800k opus 64k direct
run_case direct-relay-720p30-2500k-opus96k push 1280 720 30 h264-baseline 2500k opus 96k direct
run_case direct-relay-1080p30-6000k-opus128k push 1920 1080 30 h264-baseline 6000k opus 128k direct
run_case direct-streamid-1080p30-6000k-opus128k streamid 1920 1080 30 h264-baseline 6000k opus 128k direct
run_case direct-relay-1080p60-10000k-opus160k push 1920 1080 60 h264-baseline 10000k opus 160k direct
run_case direct-relay-2160p30-25000k-opus160k push 3840 2160 30 h264-baseline 25000k opus 160k direct
run_case direct-streamid-2160p30-25000k-opus160k streamid 3840 2160 30 h264-baseline 25000k opus 160k direct
run_case direct-high-1080p30-6000k-opus128k push 1920 1080 30 h264-high 6000k opus 128k direct
run_case audio-aac-720p30-2500k-128k push 1280 720 30 h264-baseline 2500k aac 128k transcoded
run_case audio-ac3-1080p30-6000k-384k push 1920 1080 30 h264-baseline 6000k ac3 384k transcoded
run_case video-bframes-720p30-2500k-opus96k push 1280 720 30 h264-bframes 2500k opus 96k transcoded
run_case video-h265-720p30-2500k-opus96k push 1280 720 30 h265 2500k opus 96k transcoded
run_case full-h265-360p30-800k-aac96k push 640 360 30 h265 800k aac 96k transcoded
run_case full-h265-720p30-2500k-aac128k push 1280 720 30 h265 2500k aac 128k transcoded
run_case full-h265-1080p30-6000k-aac192k push 1920 1080 30 h265 6000k aac 192k transcoded
run_case full-h265-1080p60-10000k-aac256k push 1920 1080 60 h265 10000k aac 256k transcoded
run_case full-h265-2160p30-15000k-aac256k push 3840 2160 30 h265 15000k aac 256k transcoded
run_case legacy-mpeg2-720p30-4000k-mp2-192k push 1280 720 30 mpeg2 4000k mp2 192k transcoded
run_case legacy-mpeg4-720p30-3000k-ac3-384k push 1280 720 30 mpeg4 3000k ac3 384k transcoded
run_case audio-only-opus64k push 0 0 0 none 0 opus 64k direct
run_case audio-only-aac256k push 0 0 0 none 0 aac 256k transcoded
run_case video-only-h265-1080p30-6000k push 1920 1080 30 h265 6000k none 0 transcoded

printf '\nSummary: %d passed, %d failed\n' "$passes" "$failures"
if ((failures > 0)); then
  exit 1
fi
